'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------------------------------------------------------------------------
// Constants & Semantic Concept Dictionary (mirrors backend/retrieval/semantic.py)
// ---------------------------------------------------------------------------
const { execFileSync } = require('child_process');

const IMAGE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff', '.gif',
]);

const SUPPORTED_EXTS = new Set([
  '.pdf', '.docx', '.xlsx', '.xlsm', '.pptx', '.csv', '.tsv',
  '.txt', '.md', '.json', '.xml', '.html', '.htm', '.log', '.rtf',
  ...IMAGE_EXTS,
]);

const SKIP_DIRS = new Set([
  '.git', '.svn', '.hg', 'node_modules', '__pycache__', '.venv', 'venv',
  '.pytest_cache', '.next', 'dist', 'build', 'release', 'appdata',
  '$recycle.bin', 'system volume information', 'recovery', '$winreagent', 'config.msi', 'msocache',
  'windows', 'program files', 'program files (x86)', 'programdata',
  'windowsapps', 'wpsystem', 'steamlibrary', 'xboxgames', 'onedrivetemp',
  'perflogs', 'found.000', 'temp', 'tmp', '.cache',
]);

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'under', 'about',
  'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either',
  'all', 'each', 'every', 'any', 'few', 'more', 'most', 'other', 'some',
  'such', 'no', 'only', 'own', 'same', 'than', 'too', 'very', 'just',
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'it',
  'they', 'them', 'their', 'what', 'which', 'who', 'whom', 'this',
  'that', 'these', 'those', 'there', 'here', 'where', 'when', 'why',
  'how', 'give', 'show', 'find', 'list', 'get', 'tell', 'please',
  'need', 'want', 'looking', 'connected', 'folder', 'files', 'file',
  'document', 'documents', 'docs', 'data', 'local', 'storage',
]);

const SEMANTIC_CONCEPTS = {
  __c_overdue__: [
    'overdue', 'past due', 'late', 'unpaid', 'delayed', 'delinquent',
    'missed deadline', 'defaulted', 'outstanding', 'arrears', 'expired',
  ],
  __c_invoice__: [
    'invoice', 'invoices', 'bill', 'bills', 'billing', 'receipt',
    'payable', 'receivable', 'inv', 'tax invoice', 'payment schedule',
  ],
  __c_due_date__: [
    'due date', 'due', 'deadline', 'payment due', 'maturity',
    'payable by', 'expiry', 'end date', 'renewal date', 'target date',
  ],
  __c_employee__: [
    'employee', 'employees', 'staff', 'worker', 'workers', 'personnel',
    'headcount', 'workforce', 'team member', 'emp', 'hr', 'payroll',
    'attendance', 'joining date', 'probation', 'salary',
  ],
  __c_customer__: [
    'customer', 'customers', 'client', 'clients', 'buyer', 'buyers',
    'account', 'accounts', 'consumer', 'subscriber', 'cust', 'orders',
  ],
  __c_vendor__: [
    'vendor', 'vendors', 'supplier', 'suppliers', 'merchant', 'merchants',
    'provider', 'contractor',
  ],
  __c_contract__: [
    'contract', 'contracts', 'agreement', 'agreements', 'nda', 'msa',
    'sla', 'license', 'renewal', 'terms', 'clause', 'purchase agreement',
  ],
  __c_project__: [
    'project', 'projects', 'sprint', 'milestone', 'deliverable', 'task',
    'tasks', 'roadmap', 'initiative', 'status report',
  ],
  __c_finance__: [
    'finance', 'financial', 'revenue', 'budget', 'forecast', 'expense',
    'transactions', 'bank statement', 'ledger', 'cash flow', 'profit',
    'loss', 'gst', 'tax', 'amount', 'inr', 'usd',
  ],
  __c_resume__: [
    'resume', 'resumes', 'cv', 'candidate', 'applicant', 'portfolio',
    'skills', 'experience',
  ],
  __c_support__: [
    'support', 'ticket', 'tickets', 'case', 'cases', 'escalation', 'incident', 'csat',
  ],
};

const PHRASE_TO_CONCEPT = [];
for (const [concept, terms] of Object.entries(SEMANTIC_CONCEPTS)) {
  for (const term of terms) {
    PHRASE_TO_CONCEPT.push([term, concept]);
  }
}

const MONTH_MAP = {
  january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2,
  april: 3, apr: 3, may: 4, june: 5, jun: 5,
  july: 6, jul: 6, august: 7, aug: 7, september: 8, sep: 8, sept: 8,
  october: 9, oct: 9, november: 10, nov: 10, december: 11, dec: 11,
};

// ---------------------------------------------------------------------------
// Fast NLP, Stemming & Sparse Semantic Vector Helpers
// ---------------------------------------------------------------------------
function normalizeQueryTypos(text) {
  if (!text) return '';
  let s = String(text);
  const rules = [
    [/\b(?:did['’]?n['’]?t?|didn['’]?t|did\s+not|haven['’]?t|havent|have\s+not|not)\s+(?:pay|paid|payed)\b/gi, 'unpaid'],
    [/\bmore\s+then\b/gi, 'more than'],
    [/\bgreater\s+then\b/gi, 'greater than'],
    [/\bhigher\s+then\b/gi, 'higher than'],
    [/\bbigger\s+then\b/gi, 'bigger than'],
    [/\blarger\s+then\b/gi, 'larger than'],
    [/\bless\s+then\b/gi, 'less than'],
    [/\bfewer\s+then\b/gi, 'fewer than'],
    [/\blower\s+then\b/gi, 'lower than'],
    [/\bsmaller\s+then\b/gi, 'smaller than'],
    [/\b(?:invoics|invoces|invoic|invoce)\b/gi, 'invoice'],
    [/\b(?:customres|customrs|customr|cutomers|cutomer|costomers|costomer)\b/gi, 'customers'],
    [/\b(?:employes|employe|emplyees|emplyee|emploees|emploee)\b/gi, 'employees'],
    [/\b(?:salry|salery|sallery|salries|saleries)\b/gi, 'salary'],
    [/\b(?:agrement|agrements)\b/gi, 'agreement'],
    [/\b(?:cntract|contrac|contrcts)\b/gi, 'contract'],
    [/\bpayed\b/gi, 'paid'],
    [/\bover\s+due\b/gi, 'overdue'],
  ];
  for (const [pat, repl] of rules) {
    s = s.replace(pat, repl);
  }
  return s;
}

function lightStem(word) {
  const w = String(word || '').toLowerCase().trim();
  if (w.length <= 3) return w;
  if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y';
  if (w.endsWith('ves') && w.length > 4) return w.slice(0, -3) + 'f';
  if (/(?:ches|shes|sses|xes|zes)$/.test(w) && w.length > 5) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss') && w.length > 3) return w.slice(0, -1);
  if (w.endsWith('ing') && w.length > 5) return w.slice(0, -3);
  if (w.endsWith('ed') && w.length > 4) return w.slice(0, -2);
  return w;
}

function tokenize(text, dropStopwords = true) {
  if (!text) return [];
  const raw = normalizeQueryTypos(text).toLowerCase().match(/[a-z0-9]+(?:[-_][a-z0-9]+)*/g) || [];
  const out = [];
  for (const tok of raw) {
    if (dropStopwords && STOPWORDS.has(tok)) continue;
    out.push(tok);
    if (tok.includes('-') || tok.includes('_')) {
      for (const part of tok.split(/[-_]/)) {
        if (part.length >= 2 && (!dropStopwords || !STOPWORDS.has(part))) {
          out.push(part);
        }
      }
    }
  }
  return out;
}

function extractConcepts(text) {
  const normalized = ' ' + normalizeQueryTypos(text || '').toLowerCase().replace(/[^a-z0-9/+]+/g, ' ') + ' ';
  const found = new Set();
  for (const [phrase, concept] of PHRASE_TO_CONCEPT) {
    if (normalized.includes(' ' + phrase + ' ')) {
      found.add(concept);
    }
  }
  return found;
}

function buildSparseSemanticVector(text, includeTrigrams = true) {
  if (!text) return {};
  const vec = {};
  const tokens = tokenize(text, true).slice(0, 450);
  for (const tok of tokens) {
    const stem = lightStem(tok);
    const wk = 'w:' + stem;
    vec[wk] = (vec[wk] || 0) + 1.0;
    if (includeTrigrams && tok.length >= 4 && tok.length <= 24) {
      const padded = '^' + tok + '$';
      for (let i = 0; i <= padded.length - 3; i++) {
        const gk = 'g:' + padded.slice(i, i + 3);
        vec[gk] = (vec[gk] || 0) + 0.32;
      }
    }
  }
  for (const c of extractConcepts(text)) {
    const ck = 'c:' + c;
    vec[ck] = (vec[ck] || 0) + 1.65;
  }
  let sq = 0;
  for (const k of Object.keys(vec)) sq += vec[k] * vec[k];
  const norm = Math.sqrt(sq);
  if (norm <= 0) return {};
  for (const k of Object.keys(vec)) vec[k] = vec[k] / norm;
  return vec;
}

function sparseCosineSimilarity(a, b) {
  if (!a || !b) return 0;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (!keysA.length || !keysB.length) return 0;
  const [small, large] = keysA.length <= keysB.length ? [a, b] : [b, a];
  let dot = 0;
  for (const k of Object.keys(small)) {
    if (large[k]) dot += small[k] * large[k];
  }
  return Math.max(0, Math.min(1, dot));
}

// ---------------------------------------------------------------------------
// PDF Multi-Filter Text Extractor (Supports ASCII85Decode + FlateDecode + Hex)
// ---------------------------------------------------------------------------
function decodeAscii85(inputBuf) {
  let str = Buffer.isBuffer(inputBuf) ? inputBuf.toString('latin1') : String(inputBuf || '');
  str = str.trim();
  if (str.startsWith('<~')) str = str.slice(2);
  const eod = str.indexOf('~>');
  if (eod !== -1) str = str.slice(0, eod);

  const out = [];
  let group = [];
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    // Skip whitespace
    if (ch === 32 || ch === 9 || ch === 10 || ch === 13 || ch === 12 || ch === 0) continue;
    if (ch === 122 && group.length === 0) {
      // 'z' shorthand for four zero bytes
      out.push(0, 0, 0, 0);
      continue;
    }
    if (ch < 33 || ch > 117) continue;
    group.push(ch - 33);
    if (group.length === 5) {
      let val =
        group[0] * 52200625 +
        group[1] * 614125 +
        group[2] * 7225 +
        group[3] * 85 +
        group[4];
      out.push((val >>> 24) & 0xff, (val >>> 16) & 0xff, (val >>> 8) & 0xff, val & 0xff);
      group = [];
    }
  }
  if (group.length > 1) {
    const count = group.length - 1;
    while (group.length < 5) group.push(84); // pad with 'u' (84)
    let val =
      group[0] * 52200625 +
      group[1] * 614125 +
      group[2] * 7225 +
      group[3] * 85 +
      group[4];
    for (let k = 0; k < count; k++) {
      out.push((val >>> (24 - k * 8)) & 0xff);
    }
  }
  return Buffer.from(out);
}

function decodeAsciiHex(inputBuf) {
  const hex = (Buffer.isBuffer(inputBuf) ? inputBuf.toString('latin1') : String(inputBuf || ''))
    .replace(/[^0-9A-Fa-f]/g, '');
  const padded = hex.length % 2 === 1 ? hex + '0' : hex;
  return Buffer.from(padded, 'hex');
}

function tryInflate(buf) {
  try {
    return zlib.inflateSync(buf);
  } catch {
    try {
      return zlib.inflateRawSync(buf);
    } catch {
      return null;
    }
  }
}

function decodePdfLiteralString(rawLiteral) {
  // rawLiteral includes outer ( )
  let s = rawLiteral.slice(1, -1);
  // Check UTF-16BE BOM (\xfe\xff) before unescaping if present in raw bytes
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) {
      const n = s[i + 1];
      if (n === 'n') { bytes.push(10); i++; continue; }
      if (n === 'r') { bytes.push(13); i++; continue; }
      if (n === 't') { bytes.push(9); i++; continue; }
      if (n === 'b') { bytes.push(8); i++; continue; }
      if (n === 'f') { bytes.push(12); i++; continue; }
      if (n === '(' || n === ')' || n === '\\') { bytes.push(n.charCodeAt(0)); i++; continue; }
      if (n === '\r' || n === '\n') {
        i++;
        if (n === '\r' && s[i + 1] === '\n') i++;
        continue;
      }
      if (n >= '0' && n <= '7') {
        const octM = s.slice(i + 1, i + 4).match(/^[0-7]{1,3}/);
        if (octM) {
          bytes.push(parseInt(octM[0], 8) & 0xff);
          i += octM[0].length;
          continue;
        }
      }
    }
    bytes.push(s.charCodeAt(i) & 0xff);
  }
  const b = Buffer.from(bytes);
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    // UTF-16BE -> swap pairs for Node utf16le
    const swapped = Buffer.allocUnsafe(b.length - 2);
    for (let i = 2; i + 1 < b.length; i += 2) {
      swapped[i - 2] = b[i + 1];
      swapped[i - 1] = b[i];
    }
    return swapped.toString('utf16le');
  }
  return b.toString('latin1');
}

function decodePdfHexString(hexToken) {
  const clean = hexToken.slice(1, -1).replace(/\s+/g, '');
  if (!clean) return '';
  const buf = Buffer.from(clean.length % 2 === 1 ? clean + '0' : clean, 'hex');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.allocUnsafe(buf.length - 2);
    for (let i = 2; i + 1 < buf.length; i += 2) {
      swapped[i - 2] = buf[i + 1];
      swapped[i - 1] = buf[i];
    }
    return swapped.toString('utf16le');
  }
  return buf.toString('latin1');
}

function extractTextFromPdfContentStream(decodedText) {
  const lines = [];
  let currentLine = [];

  const flushLine = () => {
    if (currentLine.length) {
      const joined = currentLine.join(' ').replace(/\s{2,}/g, ' ').trim();
      if (joined) lines.push(joined);
      currentLine = [];
    }
  };

  // Scan PDF operators in stream order: (...) literals, <hex>, and positioning ops (Td, TD, T*, Tm, BT, ET)
  const tokenRe = /(\((?:\\.|[^()\\]|\([^()]*\))*\))|(<[0-9A-Fa-f\s]+>)|(\b(?:Td|TD|T\*|Tm|BT|ET)\b)/g;
  let m;
  let lastY = null;
  while ((m = tokenRe.exec(decodedText)) !== null) {
    if (m[1]) {
      const txt = decodePdfLiteralString(m[1]).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
      if (txt) currentLine.push(txt);
    } else if (m[2]) {
      const txt = decodePdfHexString(m[2]).replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
      if (txt && /[A-Za-z0-9]/.test(txt)) currentLine.push(txt);
    } else if (m[3]) {
      const op = m[3];
      if (op === 'T*' || op === 'ET' || op === 'TD') {
        flushLine();
      } else if (op === 'Td' || op === 'Tm') {
        // Check preceding two numbers in decodedText to see if vertical coordinate changed significantly
        const ctxStart = Math.max(0, m.index - 40);
        const before = decodedText.slice(ctxStart, m.index).trim();
        const nums = before.match(/-?\d+(?:\.\d+)?/g);
        if (op === 'Td' && nums && nums.length >= 2) {
          const dy = parseFloat(nums[nums.length - 1]);
          if (Math.abs(dy) >= 2.0) flushLine();
        } else if (op === 'Tm' && nums && nums.length >= 6) {
          const y = parseFloat(nums[nums.length - 1]);
          if (lastY === null || Math.abs(y - lastY) >= 2.0) flushLine();
          lastY = y;
        } else {
          flushLine();
        }
      }
    }
  }
  flushLine();
  return lines.join('\n');
}

function extractPdfTextNode(buf) {
  if (!buf || !buf.length) return '';
  const latin = buf.toString('latin1');
  const pages = [];
  const streamRe = /stream(?:\r\n|\n|\r)([\s\S]*?)(?:\r\n|\n|\r)?endstream/g;
  let match;
  let checked = 0;

  while ((match = streamRe.exec(latin)) !== null) {
    checked++;
    // Read dictionary header preceding this stream
    const dictStart = Math.max(0, match.index - 600);
    const dictChunk = latin.slice(dictStart, match.index);
    const rawPayload = Buffer.from(match[1], 'latin1');
    let decodedBuf = rawPayload;

    const hasA85 = /ASCII85Decode/i.test(dictChunk) || rawPayload.slice(-4).toString('latin1').includes('~>');
    const hasHex = /ASCIIHexDecode/i.test(dictChunk);
    const hasFlate = /FlateDecode/i.test(dictChunk);

    if (hasA85) {
      decodedBuf = decodeAscii85(decodedBuf);
    } else if (hasHex) {
      decodedBuf = decodeAsciiHex(decodedBuf);
    }

    if (hasFlate || (!hasA85 && !hasHex && decodedBuf.length >= 2 && decodedBuf[0] === 0x78)) {
      const inflated = tryInflate(decodedBuf);
      if (inflated && inflated.length > 0) {
        decodedBuf = inflated;
      } else if (hasFlate && hasA85) {
        // Retry raw inflate just in case
        const retry = tryInflate(rawPayload);
        if (retry) decodedBuf = retry;
      }
    }

    const decodedStr = decodedBuf.toString('latin1');
    // Only extract content streams (contain PDF text operators BT/Tj/TJ or literal strings)
    if (decodedStr.includes('Tj') || decodedStr.includes('TJ') || decodedStr.includes('BT')) {
      const extracted = extractTextFromPdfContentStream(decodedStr);
      if (extracted && /[A-Za-z0-9]/.test(extracted)) {
        pages.push(extracted);
      }
    }
  }
  return pages.join('\n').trim();
}

// ---------------------------------------------------------------------------
// Pure-Node OOXML ZIP Central-Directory Reader (.docx / .xlsx / .pptx)
// ---------------------------------------------------------------------------
function readZipEntries(buf) {
  const entries = new Map();
  if (!buf || buf.length < 22) return entries;

  // Locate End of Central Directory (PK\x05\x06) from the end of buffer
  let eocdOffset = -1;
  const searchMin = Math.max(0, buf.length - 65560);
  for (let i = buf.length - 22; i >= searchMin; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) return entries;

  const cdCount = buf.readUInt16LE(eocdOffset + 10);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  let pos = cdOffset;

  for (let i = 0; i < cdCount && pos + 46 <= buf.length; i++) {
    if (buf[pos] !== 0x50 || buf[pos + 1] !== 0x4b || buf[pos + 2] !== 0x01 || buf[pos + 3] !== 0x02) break;
    const method = buf.readUInt16LE(pos + 10);
    const compSize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localHeaderOffset = buf.readUInt32LE(pos + 42);
    const name = buf.toString('utf8', pos + 46, pos + 46 + nameLen);
    pos += 46 + nameLen + extraLen + commentLen;

    if (!compSize || localHeaderOffset + 30 > buf.length) continue;
    const lNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const lExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + lNameLen + lExtraLen;
    if (dataStart + compSize > buf.length) continue;

    const slice = buf.subarray(dataStart, dataStart + compSize);
    try {
      let data = null;
      if (method === 0) data = slice;
      else if (method === 8) data = zlib.inflateRawSync(slice);
      if (data) entries.set(name, data);
    } catch {
      // skip corrupt archive entry
    }
  }
  return entries;
}

function decodeXmlEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(parseInt(d, 10)));
}

function stripXmlPreserveLines(xml) {
  return decodeXmlEntities(
    xml
      .replace(/<\/(?:w:p|w:tr|a:p|p)>/gi, '\n')
      .replace(/<w:tab[^>]*\/>/gi, ' | ')
      .replace(/<\/w:tc>/gi, ' | ')
      .replace(/<[^>]+>/g, ' ')
  )
    .split('\n')
    .map((l) => l.replace(/\s{2,}/g, ' ').replace(/\s*\|\s*/g, ' | ').replace(/^\|\s*|\s*\|$/g, '').trim())
    .filter(Boolean)
    .join('\n');
}

function excelSerialToIsoDate(serial) {
  if (!Number.isFinite(serial) || serial < 20000 || serial > 80000) return null;
  const epochMs = Date.UTC(1899, 11, 30) + Math.round(serial) * 86400000;
  const d = new Date(epochMs);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function extractXlsxText(buf) {
  const entries = readZipEntries(buf);
  if (!entries.size) return '';

  // Read shared strings
  const sharedStrings = [];
  const ssBuf = entries.get('xl/sharedStrings.xml');
  if (ssBuf) {
    const ssXml = ssBuf.toString('utf8');
    const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
    let m;
    while ((m = siRe.exec(ssXml)) !== null) {
      const parts = [];
      const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
      let tm;
      while ((tm = tRe.exec(m[1])) !== null) {
        parts.push(decodeXmlEntities(tm[1]));
      }
      sharedStrings.push(parts.join(''));
    }
  }

  // Read styles to spot date number formats (heuristic + custom numFmts)
  const dateStyleIds = new Set([14, 15, 16, 17, 22]);
  const xfDateIndexes = new Set();
  const stBuf = entries.get('xl/styles.xml');
  if (stBuf) {
    const stXml = stBuf.toString('utf8');
    const nfRe = /numFmtId="(\d+)"[^>]*formatCode="([^"]+)"/g;
    let nfm;
    while ((nfm = nfRe.exec(stXml)) !== null) {
      if (/[ymd]/i.test(nfm[2]) && !/[#0]\.0/.test(nfm[2])) {
        dateStyleIds.add(parseInt(nfm[1], 10));
      }
    }
    const cellXfsM = stXml.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/);
    if (cellXfsM) {
      const xfRe = /<xf\b([^>]*)/g;
      let xfm;
      let idx = 0;
      while ((xfm = xfRe.exec(cellXfsM[1])) !== null) {
        const nfIdM = xfm[1].match(/numFmtId="(\d+)"/);
        if (nfIdM && dateStyleIds.has(parseInt(nfIdM[1], 10))) {
          xfDateIndexes.add(idx);
        }
        idx++;
      }
    }
  }

  // Map sheet names
  const sheetNames = [];
  const wbBuf = entries.get('xl/workbook.xml');
  if (wbBuf) {
    const wbXml = wbBuf.toString('utf8');
    const shRe = /<sheet\b[^>]*name="([^"]+)"/g;
    let shm;
    while ((shm = shRe.exec(wbXml)) !== null) sheetNames.push(decodeXmlEntities(shm[1]));
  }

  const sheetFiles = Array.from(entries.keys())
    .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(k))
    .sort((a, b) => {
      const na = parseInt(a.match(/\d+/)[0], 10);
      const nb = parseInt(b.match(/\d+/)[0], 10);
      return na - nb;
    });

  const out = [];
  for (let sIdx = 0; sIdx < sheetFiles.length; sIdx++) {
    const xml = entries.get(sheetFiles[sIdx]).toString('utf8');
    const title = sheetNames[sIdx] || ('Sheet' + (sIdx + 1));
    out.push('[Sheet ' + title + ']');
    const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
    let rm;
    let rowCount = 0;
    while ((rm = rowRe.exec(xml)) !== null) {
      rowCount++;
      const cells = [];
      const cRe = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
      let cm;
      while ((cm = cRe.exec(rm[1])) !== null) {
        const attrs = cm[1];
        const body = cm[2];
        const tM = attrs.match(/\bt="([^"]+)"/);
        const sM = attrs.match(/\bs="(\d+)"/);
        const cType = tM ? tM[1] : '';
        const styleIdx = sM ? parseInt(sM[1], 10) : -1;
        let val = '';
        if (cType === 'inlineStr') {
          const isM = body.match(/<t\b[^>]*>([\s\S]*?)<\/t>/);
          val = isM ? decodeXmlEntities(isM[1]) : '';
        } else {
          const vM = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
          if (vM) {
            const rawV = decodeXmlEntities(vM[1]);
            if (cType === 's') {
              val = sharedStrings[parseInt(rawV, 10)] ?? rawV;
            } else if (!cType && styleIdx >= 0 && xfDateIndexes.has(styleIdx)) {
              const iso = excelSerialToIsoDate(parseFloat(rawV));
              val = iso || rawV;
            } else {
              val = rawV;
            }
          }
        }
        cells.push(String(val).replace(/\s+/g, ' ').trim());
      }
      if (cells.some(Boolean)) out.push(cells.join(' | '));
    }
  }
  return out.join('\n');
}

function extractDocxText(buf) {
  const entries = readZipEntries(buf);
  const parts = [];
  for (const key of ['word/document.xml', 'word/header1.xml', 'word/footer1.xml']) {
    const xmlBuf = entries.get(key);
    if (xmlBuf) {
      parts.push(stripXmlPreserveLines(xmlBuf.toString('utf8')));
    }
  }
  return parts.filter(Boolean).join('\n');
}

function extractPptxText(buf) {
  const entries = readZipEntries(buf);
  const slides = Array.from(entries.keys())
    .filter((k) => /^ppt\/slides\/slide\d+\.xml$/i.test(k))
    .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));
  return slides.map((k) => stripXmlPreserveLines(entries.get(k).toString('utf8'))).filter(Boolean).join('\n\n');
}

function extractCsvText(raw) {
  const lines = String(raw || '').split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    // Simple RFC-compliant CSV field splitter
    const cells = [];
    let cur = '';
    let inQuotes = false;
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (ch === '"') {
        if (inQuotes && line[j + 1] === '"') { cur += '"'; j++; }
        else inQuotes = !inQuotes;
      } else if (ch === ',' && !inQuotes) {
        cells.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    cells.push(cur.trim());
    out.push(cells.join(' | '));
  }
  return out.join('\n');
}

function extractImageOcrWinRT(fullPath) {
  if (process.platform !== 'win32' || !fullPath) return '';
  try {
    const ps = [
      'param([string]$p)',
      'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
      '[Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime] | Out-Null',
      '[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime] | Out-Null',
      '[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime] | Out-Null',
      '$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq "IAsyncOperation`1" })[0]',
      'function Await-RT($op, $t) { $n = $asTaskGeneric.MakeGenericMethod($t).Invoke($null, @($op)); $n.Wait(-1) | Out-Null; $n.Result }',
      '$f = Await-RT ([Windows.Storage.StorageFile]::GetFileFromPathAsync($p)) ([Windows.Storage.StorageFile])',
      '$s = Await-RT ($f.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])',
      '$d = Await-RT ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($s)) ([Windows.Graphics.Imaging.BitmapDecoder])',
      '$b = Await-RT ($d.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])',
      '$e = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()',
      'if ($null -eq $e) { exit 0 }',
      '$r = Await-RT ($e.RecognizeAsync($b)) ([Windows.Media.Ocr.OcrResult])',
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      '$r.Lines | ForEach-Object { Write-Output $_.Text }',
    ].join('\n');
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps, path.resolve(fullPath)],
      { encoding: 'utf8', timeout: 8000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
    );
    return String(out || '').trim();
  } catch {
    return '';
  }
}

const NODE_TEXT_READ_MAX_BYTES = 4 * 1024 * 1024;
const NODE_BINARY_FALLBACK_MAX_BYTES = 24 * 1024 * 1024;

function _readTextHeadSync(fullPath, sizeBytes) {
  if (!sizeBytes || sizeBytes <= NODE_TEXT_READ_MAX_BYTES) {
    return fs.readFileSync(fullPath, 'utf8');
  }
  const fd = fs.openSync(fullPath, 'r');
  try {
    const buf = Buffer.allocUnsafe(NODE_TEXT_READ_MAX_BYTES);
    const bytesRead = fs.readSync(fd, buf, 0, NODE_TEXT_READ_MAX_BYTES, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

async function _readTextHeadAsync(fullPath, sizeBytes) {
  if (!sizeBytes || sizeBytes <= NODE_TEXT_READ_MAX_BYTES) {
    return await fs.promises.readFile(fullPath, 'utf8');
  }
  const handle = await fs.promises.open(fullPath, 'r');
  try {
    const buf = Buffer.allocUnsafe(NODE_TEXT_READ_MAX_BYTES);
    const { bytesRead } = await handle.read(buf, 0, NODE_TEXT_READ_MAX_BYTES, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

function extractFileTextNode(fullPath, ext, sizeBytes) {
  if (!SUPPORTED_EXTS.has(ext) || sizeBytes > 256 * 1024 * 1024) return '';
  try {
    if (IMAGE_EXTS.has(ext)) {
      // Do not run synchronous child-process PowerShell OCR on the main thread during bulk indexing.
      // Image filenames, directory paths, and metadata provide instant non-blocking search.
      return '';
    }
    if (['.txt', '.md', '.json', '.xml', '.html', '.htm', '.log', '.tsv', '.rtf'].includes(ext)) {
      let raw = _readTextHeadSync(fullPath, sizeBytes);
      if (raw.length > 4000000) raw = raw.slice(0, 4000000);
      if (ext === '.tsv') return raw.split(/\r?\n/).map((l) => l.split('\t').map((c) => c.trim()).join(' | ')).join('\n');
      if (ext === '.html' || ext === '.htm' || ext === '.xml') return stripXmlPreserveLines(raw);
      return raw.trim();
    }
    if (ext === '.csv') {
      return extractCsvText(_readTextHeadSync(fullPath, sizeBytes));
    }
    if (sizeBytes > NODE_BINARY_FALLBACK_MAX_BYTES) return '';
    const buf = fs.readFileSync(fullPath);
    if (ext === '.pdf') return extractPdfTextNode(buf);
    if (ext === '.xlsx' || ext === '.xlsm') return extractXlsxText(buf);
    if (ext === '.docx') return extractDocxText(buf);
    if (ext === '.pptx') return extractPptxText(buf);
  } catch {
    return '';
  }
  return '';
}

async function extractFileTextNodeAsync(fullPath, ext, sizeBytes) {
  if (!SUPPORTED_EXTS.has(ext) || sizeBytes > 256 * 1024 * 1024) return '';
  try {
    if (IMAGE_EXTS.has(ext)) {
      return '';
    }
    if (['.txt', '.md', '.json', '.xml', '.html', '.htm', '.log', '.tsv', '.rtf'].includes(ext)) {
      let raw = await _readTextHeadAsync(fullPath, sizeBytes);
      if (raw.length > 4000000) raw = raw.slice(0, 4000000);
      if (ext === '.tsv') return raw.split(/\r?\n/).map((l) => l.split('\t').map((c) => c.trim()).join(' | ')).join('\n');
      if (ext === '.html' || ext === '.htm' || ext === '.xml') return stripXmlPreserveLines(raw);
      return raw.trim();
    }
    if (ext === '.csv') {
      return extractCsvText(await _readTextHeadAsync(fullPath, sizeBytes));
    }
    if (sizeBytes > NODE_BINARY_FALLBACK_MAX_BYTES) return '';
    const buf = await fs.promises.readFile(fullPath);
    if (ext === '.pdf') return extractPdfTextNode(buf);
    if (ext === '.xlsx' || ext === '.xlsm') return extractXlsxText(buf);
    if (ext === '.docx') return extractDocxText(buf);
    if (ext === '.pptx') return extractPptxText(buf);
  } catch {
    return '';
  }
  return '';
}

// ---------------------------------------------------------------------------
// Date Parsing, Invoice Overdue & Entity Extraction Helpers
// ---------------------------------------------------------------------------
function cleanStr(val) {
  if (val === null || val === undefined) return '';
  return String(val)
    .replace(/\u25a0/g, '')
    .replace(/\xa0/g, ' ')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function parseFlexibleDate(raw) {
  let s = cleanStr(raw);
  if (!s) return null;
  s = s.replace(/\s+\d{1,2}:\d{2}(?::\d{2})?.*$/, '').trim();
  s = s.replace(/(\d)(?:st|nd|rd|th)\b/gi, '$1');

  // YYYY-MM-DD or YYYY/MM/DD
  let m = s.match(/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/);
  if (m) {
    const dt = new Date(Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10)));
    if (!isNaN(dt.getTime())) return dt;
  }
  // DD Month YYYY
  m = s.match(/\b(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\b/);
  if (m && MONTH_MAP[m[2].toLowerCase()] !== undefined) {
    const dt = new Date(Date.UTC(parseInt(m[3], 10), MONTH_MAP[m[2].toLowerCase()], parseInt(m[1], 10)));
    if (!isNaN(dt.getTime())) return dt;
  }
  // Month DD, YYYY
  m = s.match(/\b([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})\b/);
  if (m && MONTH_MAP[m[1].toLowerCase()] !== undefined) {
    const dt = new Date(Date.UTC(parseInt(m[3], 10), MONTH_MAP[m[1].toLowerCase()], parseInt(m[2], 10)));
    if (!isNaN(dt.getTime())) return dt;
  }
  // DD-MM-YYYY or DD/MM/YYYY
  m = s.match(/\b(\d{1,2})[-/](\d{1,2})[-/](\d{4})\b/);
  if (m) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    const yr = parseInt(m[3], 10);
    const month = b <= 12 ? b - 1 : a - 1;
    const day = b <= 12 ? a : b;
    const dt = new Date(Date.UTC(yr, month, day));
    if (!isNaN(dt.getTime())) return dt;
  }
  return null;
}

function toIsoDate(dt) {
  return dt ? dt.toISOString().slice(0, 10) : '';
}

function evaluateOverdue(status, invoiceDateRaw, dueDateRaw, paymentTermsRaw = '', refDate = new Date()) {
  const todayUtc = new Date(Date.UTC(refDate.getUTCFullYear(), refDate.getUTCMonth(), refDate.getUTCDate()));
  const invDt = parseFlexibleDate(invoiceDateRaw);
  let dueDt = parseFlexibleDate(dueDateRaw);
  if (!dueDt && invDt && paymentTermsRaw) {
    const nm = String(paymentTermsRaw).match(/\b(?:net\s*)?(\d{1,3})\s*days?\b/i);
    if (nm) {
      dueDt = new Date(invDt.getTime() + parseInt(nm[1], 10) * 86400000);
    }
  }
  const normInv = invDt ? toIsoDate(invDt) : cleanStr(invoiceDateRaw);
  const normDue = dueDt ? toIsoDate(dueDt) : cleanStr(dueDateRaw);

  const sLow = String(status || '').toLowerCase();
  const isPaid = (sLow.includes('paid') && !sLow.includes('unpaid') && !sLow.includes('overdue')) || sLow.includes('settled');
  let daysOverdue = 0;
  if (dueDt && !isPaid && dueDt.getTime() < todayUtc.getTime()) {
    daysOverdue = Math.round((todayUtc.getTime() - dueDt.getTime()) / 86400000);
  }
  const explicitOverdue = sLow.includes('overdue');
  const isOverdue = explicitOverdue || daysOverdue > 0;
  let effStatus = cleanStr(status) || 'Pending';
  if (isOverdue && !effStatus.toLowerCase().includes('overdue')) {
    effStatus = effStatus.toLowerCase() !== 'pending' ? `Overdue (${effStatus})` : 'Overdue';
  }
  return { status: effStatus, rawStatus: cleanStr(status), invoiceDate: normInv, dueDate: normDue, isOverdue, daysOverdue };
}

function extractInvoicesFromText(filename, relPath, fullPath, text) {
  if (!text) return [];
  const fnLow = filename.toLowerCase();
  const txtLow = text.toLowerCase();
  if (!fnLow.includes('invoice') && !txtLow.includes('invoice') && !fnLow.includes('payment') && !fnLow.includes('billing')) {
    return [];
  }
  const results = [];
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  // 1. Check tabular rows
  const pipeLines = lines.filter((l) => l.includes('|'));
  if (pipeLines.length >= 2) {
    const headers = pipeLines[0].split('|').map((h) => h.trim().toLowerCase());
    if (headers.some((h) => h.includes('invoice') || h.includes('vendor') || h.includes('amount'))) {
      for (let i = 1; i < pipeLines.length; i++) {
        const cells = pipeLines[i].split('|').map((c) => c.trim());
        if (cells.length !== headers.length) continue;
        if (cells.every((c) => /^[-: ]*$/.test(c))) continue;
        let invId = '', amount = '', status = 'Pending', invDate = '', dueDate = '', cust = '', vendor = '';
        for (let c = 0; c < headers.length; c++) {
          const h = headers[c];
          const v = cells[c];
          if (h.includes('invoice id') || h === 'inv' || (!invId && /^INV-/i.test(v))) invId = v;
          else if (/amount|total|cost|price/.test(h)) amount = v;
          else if (h.includes('status')) status = v;
          else if (h.includes('due') && h.includes('date')) dueDate = v;
          else if (h.includes('invoice') && h.includes('date')) invDate = v;
          else if (h.includes('date') && !invDate && !dueDate) invDate = v;
          else if (/customer|client|account/.test(h)) cust = v;
          else if (h.includes('vendor')) vendor = v;
        }
        if (invId && amount) {
          const evalRes = evaluateOverdue(status, invDate, dueDate);
          results.push({
            id: cleanStr(invId),
            customer: cleanStr(cust || vendor || 'Enterprise Client'),
            hasExplicitCustomer: Boolean(cleanStr(cust)),
            vendor: cleanStr(vendor),
            amount: cleanStr(amount),
            ...evalRes,
            filePath: fullPath,
            relPath,
            filename,
          });
        }
      }
      if (results.length) return results;
    }
  }

  // 2. Key-value invoice document
  const invIdM =
    text.match(/(?:Invoice\s*(?:ID|#|No\.?|Number))\s*[:\n\-]\s*([A-Za-z0-9-]+)/i) ||
    text.match(/\b(INV-[A-Za-z0-9-]+)\b/i);
  const totalM =
    text.match(/\b(?:Grand\s*Total|Total\s*Amount|Amount\s*Due)\s*[:\n\-]\s*([^\n|]+)/i) ||
    text.match(/(?:^|\n)\s*(?:Total|Amount|Balance)\s*[:\n\-]\s*([^\n|]+)/i);

  if (invIdM && totalM) {
    const vendorM = text.match(/(?:Vendor\s*(?:Name)?|Provider|From|Billed\s*By)\s*[:\n\-]\s*([^\n|]+)/i);
    let vendor = vendorM ? cleanStr(vendorM[1]) : '';
    if (!vendor) {
      const hv = text.match(/^INVOICE\s*\n+([A-Z][^\n]{3,80})/im);
      if (hv && !hv[1].toLowerCase().includes('synthetic')) vendor = cleanStr(hv[1]);
    }
    const custM = text.match(/(?:Customer\s*(?:Name)?|Client|Bill\s*To|Billed\s*To|Company)\s*[:\n\-]\s*([^\n|]+)/i);
    const statM = text.match(/(?:Payment\s*Status|Status)\s*[:\n\-]\s*([^\n|]+)/i);
    const invDateM = text.match(/Invoice\s*Date\s*[:\n\-]\s*([^\n|]+)/i);
    const dueDateM = text.match(/(?:Due\s*Date|Payment\s*Due)\s*[:\n\-]\s*([^\n|]+)/i);
    const termsM = text.match(/(?:Payment\s*Terms|Terms)\s*[:\n\-]\s*([^\n|]+)/i);
    const genDateM = !invDateM && !dueDateM ? text.match(/\bDate\s*[:\n\-]\s*([^\n|]+)/i) : null;

    const cust = custM ? cleanStr(custM[1]) : '';
    const rawStat = statM ? cleanStr(statM[1]) : (txtLow.includes('overdue') ? 'Overdue' : 'Pending');
    const rawInvDate = invDateM ? invDateM[1] : (genDateM ? genDateM[1] : '');
    const rawDueDate = dueDateM ? dueDateM[1] : '';
    const rawTerms = termsM ? cleanStr(termsM[1]) : '';
    const evalRes = evaluateOverdue(rawStat, rawInvDate, rawDueDate, rawTerms);
    const hasExplicitCust = Boolean(cust && cust.toLowerCase() !== 'synthetic');

    results.push({
      id: cleanStr(invIdM[1]),
      customer: hasExplicitCust ? cust : (vendor || 'Enterprise Client'),
      hasExplicitCustomer: hasExplicitCust,
      vendor,
      amount: cleanStr(totalM[1]),
      paymentTerms: rawTerms,
      ...evalRes,
      filePath: fullPath,
      relPath,
      filename,
    });
  }
  return results;
}

function parseNumericAmount(raw) {
  if (raw === null || raw === undefined || typeof raw === 'boolean') return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const cleaned = String(raw).replace(/,/g, '').replace(/[^\d.]/g, '');
  if (!cleaned) return null;
  const val = parseFloat(cleaned);
  return Number.isFinite(val) ? val : null;
}

const UNIT_MULTIPLIERS = {
  k: 1e3, kpa: 1e3, thousand: 1e3, thousands: 1e3,
  l: 1e5, lk: 1e5, lac: 1e5, lacs: 1e5, lack: 1e5, lacks: 1e5, lakh: 1e5, lakhs: 1e5, lpa: 1e5, lpam: 1e5,
  cr: 1e7, cpa: 1e7, crore: 1e7, crores: 1e7,
  m: 1e6, mn: 1e6, million: 1e6, millions: 1e6,
  b: 1e9, bn: 1e9, billion: 1e9,
};

function parseHumanNumber(numStr, unitStr) {
  const base = parseNumericAmount(numStr);
  if (base === null) return null;
  const uNorm = String(unitStr || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const mult = uNorm.includes('per annum') ? 1e5 : (UNIT_MULTIPLIERS[uNorm] || 1);
  return base * mult;
}

const INVOICE_ENTITY_STOPWORDS = new Set([
  'a', 'an', 'the', 'all', 'any', 'some', 'other', 'another', 'same', 'such', 'more', 'most',
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'it', 'they', 'them', 'their',
  'this', 'that', 'these', 'those', 'which', 'who', 'whom', 'whose', 'what', 'when', 'where',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'do', 'does', 'did', 'done',
  'have', 'has', 'had', 'can', 'could', 'will', 'would', 'shall', 'should', 'may', 'might',
  'find', 'search', 'show', 'list', 'get', 'give', 'tell', 'look', 'locate', 'fetch', 'bring',
  'please', 'need', 'want', 'looking', 'connected', 'local', 'storage', 'folder', 'folders',
  'companydata', 'directory', 'in', 'on', 'at', 'by', 'for', 'from', 'of', 'to', 'with', 'about',
  'into', 'and', 'or', 'not', 'only', 'already', 'yet', 'still', 'like',
  'invoice', 'invoices', 'inv', 'bill', 'bills', 'billing', 'payment', 'payments', 'payable', 'receivable',
  'file', 'files', 'document', 'documents', 'doc', 'docs', 'record', 'records', 'data',
  'customer', 'customers', 'client', 'clients', 'vendor', 'vendors', 'supplier', 'suppliers',
  'status', 'state', 'created', 'issued', 'generated', 'dated', 'made', 'date', 'due', 'year', 'yr',
  'overdue', 'unpaid', 'paid', 'settled', 'cleared', 'pending', 'late', 'past', 'outstanding',
  'arrears', 'delinquent', 'expired', 'missed',
]);

const NON_ENTITY_DOC_TERMS = new Set([
  'receipt', 'receipts', 'purchase', 'order', 'orders', 'contract', 'contracts', 'agreement',
  'agreements', 'nda', 'msa', 'sla', 'po', 'pur', 'schedule', 'register', 'report', 'reports',
  'budget', 'forecast', 'policy', 'policies', 'handbook', 'summary', 'statement', 'sheet',
  'linked', 'related', 'associated', 'referencing', 'mentioning', 'spreadsheet', 'excel', 'csv',
  'pdf', 'docx', 'xlsx', 'tax', 'gst',
]);

function extractInvoiceEntityFilter(normQuery) {
  if (!normQuery) return '';
  const ql = normQuery.toLowerCase();
  if (/\bor\b/.test(ql)) return '';
  const words = normQuery.match(/[a-z0-9][a-z0-9&'.-]*/gi) || [];
  const rawLower = words.map((w) => w.toLowerCase().replace(/^['.-]+|['.-]+$/g, ''));
  if (rawLower.some((w) => NON_ENTITY_DOC_TERMS.has(w))) return '';

  const kept = [];
  for (const w of words) {
    const low = w.toLowerCase().replace(/^['.-]+|['.-]+$/g, '');
    if (!low || INVOICE_ENTITY_STOPWORDS.has(low) || NON_ENTITY_DOC_TERMS.has(low)) continue;
    if (/^20\d{2}$/.test(low)) continue;
    if (/^(?:inv|po|pur|cnt|ctr)[-_]?\d+$/i.test(low)) continue;
    if (/^\d+$/.test(low)) continue;
    if (low.length >= 2) kept.push(w.replace(/^['.-]+|['.-]+$/g, ''));
  }
  if (!kept.length || !kept.some((k) => k.length >= 3)) return '';
  const cand = kept.slice(0, 5).join(' ').trim();
  return cand.length >= 3 ? cand : '';
}

function matchesInvoiceEntityNode(rec, entityFilter) {
  const ef = String(entityFilter || '').trim().toLowerCase();
  if (!ef) return true;
  const hay = `${rec.customer || ''} ${rec.vendor || ''} ${rec.id || ''}`.toLowerCase();
  if (hay.includes(ef)) return true;
  const toks = (ef.match(/[a-z0-9]+/g) || []).filter((t) => t.length >= 2);
  return Boolean(toks.length && toks.every((t) => new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(hay)));
}

function parseStructuredInvoiceFilterNode(query) {
  const qRaw = String(query || '').trim();
  if (!qRaw) return null;
  const normRaw = normalizeQueryTypos(qRaw);
  const q = normRaw.toLowerCase();
  if (/(?:highest paid|best paid|lowest paid|paid leave|paid holiday|paid time off|salary|salaries|lpa|lakh|lakhs|lack)/.test(q)) {
    return null;
  }
  const hasInv = /\b(?:invoice|invoices|bill|bills|billing|payment|payments|payable|receivable)\b/.test(q);
  const hasCust = /\b(?:customer|customers|client|clients|vendor|vendors)\b/.test(q);
  let hasUnpaid = /\b(?:unpaid|overdue|past\s+due|late|pending|delinquent|arrears|outstanding|not\s+settled)\b/.test(q);
  let hasPaid = /\b(?:paid|settled|cleared)\b/.test(q) && !hasUnpaid;
  const hasRawNeg = /\b(?:did['’]?n['’]?t?|didn['’]?t|not|haven['’]?t|never)\s+(?:pay|paid|payed)\b/i.test(qRaw);
  if (hasRawNeg) { hasUnpaid = true; hasPaid = false; }
  if (!(hasInv || ((hasUnpaid || q.includes('already paid')) && (hasCust || q.includes('already paid'))))) return null;

  let statusFilter = null;
  if (/\b(?:overdue|past\s+due|late|missed\s+due)\b/.test(q)) statusFilter = 'overdue';
  else if (hasUnpaid) statusFilter = (q.includes('unpaid') || hasRawNeg || hasCust) ? 'unpaid_all' : 'pending';
  else if (hasPaid && (hasInv || q.includes('already paid'))) statusFilter = 'paid';

  let year = null;
  const mYr = q.match(/(?:^|[^a-z0-9_-])(20\d{2})(?![_-]\d)/i);
  if (mYr) year = parseInt(mYr[1], 10);

  let groupBy = null;
  if (hasCust && (hasUnpaid || hasPaid || /\b(?:which|who|list|show|what)\s+(?:all\s+)?(?:the\s+)?(?:customer|customers|client|clients|vendor|vendors)\b/.test(q))) {
    groupBy = /\b(?:vendor|vendors)\b/.test(q) && !/\b(?:customer|customers|client|clients)\b/.test(q) ? 'vendors' : 'customers';
  }
  const entityFilter = hasInv ? extractInvoiceEntityFilter(normRaw) : '';
  if (!statusFilter && !year && !groupBy && !entityFilter) return null;
  return { statusFilter, year, groupBy, entityFilter: entityFilter || null };
}

function matchesInvoiceStatusNode(status, statusFilter, isOverdue) {
  if (!statusFilter) return true;
  const s = String(status || '').toLowerCase();
  const isPaid = (s.includes('paid') && !s.includes('unpaid') && !isOverdue) || s.includes('settled') || s.includes('cleared');
  if (statusFilter === 'unpaid_all') return !isPaid;
  if (statusFilter === 'paid') return isPaid;
  if (statusFilter === 'overdue') return isOverdue || s.includes('overdue');
  if (statusFilter === 'pending') return !isPaid && !isOverdue && !s.includes('overdue');
  return s.includes(statusFilter);
}

function parseNumericFilterQuery(query) {
  const q = normalizeQueryTypos(String(query || '').trim());
  if (!q) return null;
  const ql = q.toLowerCase();

  let domain = '';
  let field = '';
  const isPaidComp = /(?:highest paid|best paid|lowest paid|top paid|well paid)/.test(ql);
  if (/\b(?:employee|employees|staff|worker|workers|personnel|salary|salaries|compensation|ctc|wage|earning|lpa)\b/.test(ql) || isPaidComp) {
    domain = 'employees';
    field = 'salary';
  } else if (/\b(?:customer|customers|client|clients|arr|annual\s*value)\b/.test(ql)) {
    domain = 'customers';
    field = 'annualValue';
  } else {
    return null;
  }

  const numFrag = '(?:₹|inr|rs\\.?|\\$|usd|eur)?\\s*(\\d[\\d,]*(?:\\.\\d+)?)\\s*(lakhs?\\s+per\\s+annum|lacs?\\s+per\\s+annum|lakhs?|lacks?|lacs?|lpa|lpam|lk|crores?|cpa|cr|millions?|mn|thousands?|kpa|k|m|bn|b)?\\b';
  let op = null;
  let minVal = null;
  let maxVal = null;
  let sortDir = 'desc';
  let topN = null;

  const betweenM = ql.match(new RegExp(`\\bbetween\\s+${numFrag}\\s*(?:and|to|-)\\s*${numFrag}`, 'i'));
  if (betweenM) {
    const v1 = parseHumanNumber(betweenM[1], betweenM[2]);
    const v2 = parseHumanNumber(betweenM[3], betweenM[4]);
    if (v1 !== null && v2 !== null) {
      op = 'between';
      minVal = Math.min(v1, v2);
      maxVal = Math.max(v1, v2);
    }
  }

  if (!op) {
    const gtM = ql.match(new RegExp(`(?:\\b(?:more\\s+th[ae]n|greater\\s+th[ae]n|higher\\s+th[ae]n|bigger\\s+th[ae]n|larger\\s+th[ae]n|exceed(?:s|ing)?|above|over|at\\s+least|min(?:imum)?)|>=?)\\s*${numFrag}`, 'i'));
    if (gtM) {
      const v = parseHumanNumber(gtM[1], gtM[2]);
      if (v !== null) {
        op = (/at\s+least|min|>=/i.test(gtM[0])) ? 'ge' : 'gt';
        minVal = v;
      }
    }
  }

  if (!op) {
    const ltM = ql.match(new RegExp(`(?:\\b(?:less\\s+th[ae]n|fewer\\s+th[ae]n|lower\\s+th[ae]n|smaller\\s+th[ae]n|under|below|up\\s+to|at\\s+most|max(?:imum)?)|<=?)\\s*${numFrag}`, 'i'));
    if (ltM) {
      const v = parseHumanNumber(ltM[1], ltM[2]);
      if (v !== null) {
        op = (/up\s+to|at\s+most|max|<=/i.test(ltM[0])) ? 'le' : 'lt';
        maxVal = v;
        sortDir = 'asc';
      }
    }
  }

  if (!op) {
    const rankM = ql.match(/\b(?:top\s+(\d+)\s+)?(?:highest|top|largest|biggest|maximum|lowest|smallest|minimum)\b/i);
    if (rankM && /\b(?:salary|salaries|paid|compensation|ctc|arr|annual\s*value)\b/i.test(ql)) {
      op = 'rank';
      sortDir = /\b(?:lowest|smallest|minimum)\b/i.test(ql) ? 'asc' : 'desc';
      if (rankM[1]) topN = Math.max(1, Math.min(100, parseInt(rankM[1], 10)));
      else {
        const tm2 = ql.match(/\btop\s+(\d+)\b/i);
        topN = tm2 ? Math.max(1, Math.min(100, parseInt(tm2[1], 10))) : 20;
      }
    }
  }

  if (!op) return null;

  let deptFilter = '';
  for (const d of ['engineering', 'finance', 'sales', 'hr', 'ai', 'operations', 'marketing', 'product', 'architect', 'manager', 'developer', 'analyst', 'director', 'engineer']) {
    if (new RegExp(`\\b${d}\\b`, 'i').test(ql)) {
      deptFilter = d;
      break;
    }
  }
  let statusFilter = '';
  for (const st of ['on leave', 'active', 'inactive', 'terminated', 'resigned', 'probation', 'enterprise', 'mid-market', 'smb']) {
    if (new RegExp(`\\b${st}\\b`, 'i').test(ql)) {
      statusFilter = st;
      break;
    }
  }

  return { domain, field, op, minVal, maxVal, sortDir, topN, deptFilter, statusFilter };
}

const VALIDATION_NOISE = new Set([
  'can', 'i', 'you', 'me', 'we', 'our', 'my', 'please', 'find', 'search', 'show',
  'get', 'give', 'list', 'look', 'locate', 'fetch', 'bring', 'another', 'other',
  'more', 'some', 'any', 'all', 'the', 'a', 'an', 'that', 'this', 'these', 'those',
  'they', 'them', 'their', 'was', 'were', 'is', 'are', 'be', 'been', 'being',
  'do', 'does', 'did', 'have', 'has', 'had', 'already', 'just', 'only', 'like',
  'with', 'for', 'from', 'in', 'on', 'at', 'by', 'to', 'of', 'and', 'or',
  'file', 'files', 'document', 'documents', 'doc', 'docs', 'record', 'records',
  'data', 'folder', 'folders', 'directory', 'created', 'linked', 'related',
  'associated', 'regarding', 'concerning', 'referencing', 'mentioning', 'available',
  'present', 'existing', 'matching', 'local', 'storage', 'companydata', 'company',
]);

const ALIAS_GROUPS = [
  new Set(['contract', 'contracts', 'agreement', 'agreements', 'msa', 'sla']),
  new Set(['invoice', 'invoices', 'inv', 'bill', 'bills', 'billing']),
  new Set(['customer', 'customers', 'client', 'clients']),
  new Set(['vendor', 'vendors', 'supplier', 'suppliers', 'merchant', 'merchants']),
  new Set(['employee', 'employees', 'staff', 'worker', 'workers', 'personnel']),
  new Set(['resume', 'resumes', 'cv', 'cvs']),
  new Set(['report', 'reports', 'reporting']),
  new Set(['receipt', 'receipts', 'voucher', 'vouchers', 'acknowledgement']),
];

function aliasesForTermNode(term, branchTerms) {
  const tl = term.toLowerCase();
  const out = new Set([tl, lightStem(tl)]);
  if (tl === 'order' && branchTerms.has('purchase')) {
    out.add('orders');
    out.add('agreement');
    out.add('agreements');
    out.add('pur-');
    out.add('po-');
  }
  for (const grp of ALIAS_GROUPS) {
    if (grp.has(tl) || grp.has(lightStem(tl))) {
      for (const g of grp) out.add(g);
    }
  }
  if (tl === 'hr' || tl === 'human') {
    for (const x of ['hr', 'human resources', 'employee', 'employees', 'payroll', 'leave']) out.add(x);
  }
  if (['pdf', 'csv', 'xlsx', 'docx', 'txt', 'pptx'].includes(tl)) out.add('.' + tl);
  return out;
}

function parseQueryConstraintsNode(query) {
  const norm = normalizeQueryTypos(String(query || '').trim()).toLowerCase();
  const hasOr = /\s+\bor\b\s+/i.test(norm);
  const rawBranches = hasOr ? norm.split(/\s+\bor\b\s+/i) : [norm];
  const branches = [];
  const branchLabels = [];

  for (const rb of rawBranches) {
    const toks = (rb.match(/[a-z0-9]+(?:[-_][a-z0-9]+)*/g) || [])
      .filter((t) => t.length >= 2 && !VALIDATION_NOISE.has(t));
    const uniqueTerms = Array.from(new Set(toks));
    if (!uniqueTerms.length) continue;
    const bSet = new Set(uniqueTerms);
    const used = new Set();
    const groups = [];
    for (let i = 0; i < uniqueTerms.length; i++) {
      if (used.has(i)) continue;
      const t = uniqueTerms[i];
      const aliases = aliasesForTermNode(t, bSet);
      const labels = [t];
      for (let j = i + 1; j < uniqueTerms.length; j++) {
        if (used.has(j)) continue;
        const other = uniqueTerms[j];
        if (aliases.has(other) || aliases.has(lightStem(other))) {
          used.add(j);
          for (const a of aliasesForTermNode(other, bSet)) aliases.add(a);
          labels.push(other);
        }
      }
      groups.push({ term: labels[0], label: labels.join(' / '), aliases });
    }
    if (groups.length) {
      branches.push(groups);
      branchLabels.push(uniqueTerms.join(' '));
    }
  }
  return { isAlternation: hasOr && branches.length >= 2, branches, branchLabels };
}

const SOFT_MODIFIER_TERMS = new Set([
  'policy', 'policies', 'guideline', 'guidelines', 'detail', 'details', 'info',
  'information', 'overview', 'note', 'notes', 'spec', 'specs', 'specification',
  'manual', 'guide',
]);

function editDistLe1Node(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && ++diff > 1) return false;
    return true;
  }
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  let i = 0, j = 0, diff = 0;
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) { i++; j++; }
    else { if (++diff > 1) return false; j++; }
  }
  return true;
}

function validateTextAgainstConstraintsNode(filename, relPath, content, constraints) {
  const branches = constraints?.branches || [];
  if (!branches.length) return { valid: true, matchedBranches: [], matchedGroups: [] };
  const isAlt = Boolean(constraints?.isAlternation);
  const hayLow = `${filename} ${relPath} ${content}`.toLowerCase();
  const haySpaced = hayLow.replace(/[_/\\-]+/g, ' ');
  const hayWords = new Set(haySpaced.match(/[a-z]{5,}/g) || []);
  const matchedBranches = [];
  let bestGroups = [];
  let bestCov = -1;

  const hasAlias = (al) => {
    if (al.length <= 3 && /^[a-z]+$/.test(al)) {
      return new RegExp(`(?:^|[^a-z0-9])${al}(?=$|[^a-z0-9])`).test(haySpaced);
    }
    if (al.startsWith('.')) return hayLow.includes(al);
    if (hayLow.includes(al) || haySpaced.includes(al)) return true;
    if (al.length >= 6 && /^[a-z]+$/.test(al)) {
      const pref = al.slice(0, 2);
      for (const w of hayWords) {
        if (w.startsWith(pref) && editDistLe1Node(al, w)) return true;
      }
    }
    return false;
  };

  branches.forEach((groups, bIdx) => {
    const req = isAlt ? groups : (groups.filter((g) => !SOFT_MODIFIER_TERMS.has(g.term)));
    const effReq = req.length ? req : groups;
    const hits = [];
    let reqHits = 0;
    for (const grp of groups) {
      let grpHit = false;
      for (const al of grp.aliases) {
        if (hasAlias(al)) { grpHit = true; break; }
      }
      if (grpHit) {
        hits.push(grp.term);
        if (effReq.includes(grp)) reqHits++;
      }
    }
    const cov = effReq.length ? reqHits / effReq.length : 1;
    if (cov > bestCov) { bestCov = cov; bestGroups = hits; }
    if (reqHits === effReq.length) matchedBranches.push(bIdx);
  });

  return { valid: matchedBranches.length > 0, matchedBranches, matchedGroups: bestGroups };
}

function isValidEntityName(name) {
  if (!name || name.length < 2 || name.length > 90) return false;
  const low = name.trim().toLowerCase();
  if (['n/a', 'na', 'none', 'null', 'unknown', 'value', 'field', 'synthetic', 'tbd', 'name', '---'].includes(low)) return false;
  if (low.startsWith('synthetic ') || low.startsWith('not real')) return false;
  return /[a-zA-Z]/.test(name);
}

function extractEntitiesFromDocument(filename, relPath, text) {
  const emp = [];
  const cust = [];
  const vend = [];
  if (!text) return { emp, cust, vend };

  const fnLow = filename.toLowerCase();
  const pathLow = relPath.toLowerCase();
  const headLow = text.slice(0, 500).toLowerCase();

  // 1. Parse pipe-table sections
  const lines = text.split('\n');
  let curHeaders = null;
  for (const rawLine of lines) {
    const sLine = rawLine.trim();
    if (!sLine.includes('|')) {
      curHeaders = null;
      continue;
    }
    const cells = sLine.split('|').map((c) => c.trim());
    if (cells.every((c) => !c || /^[-: ]+$/.test(c))) continue;
    const lowCells = cells.map((c) => c.toLowerCase());
    const joined = lowCells.join(' ');
    if (!curHeaders) {
      if (['employee', 'emp_id', 'customer', 'client', 'vendor', 'merchant', 'name', 'department', 'account'].some((k) => joined.includes(k))) {
        curHeaders = lowCells;
      }
      continue;
    }
    if (cells.length !== curHeaders.length) continue;
    const hJoin = curHeaders.join(' ');
    const isEmpTable = hJoin.includes('employee_id') || hJoin.includes('employee id') || ((fnLow.includes('employee') || fnLow.includes('attendance') || fnLow.includes('hr_')) && hJoin.includes('name'));
    const isCustTable = hJoin.includes('customer_id') || hJoin.includes('customer id') || hJoin.includes('customer name') || ((fnLow.includes('customer') || fnLow.includes('orders')) && hJoin.includes('name'));
    const isVendTable = hJoin.includes('vendor') || hJoin.includes('merchant');

    const get = (...keys) => {
      for (const k of keys) {
        const idx = curHeaders.indexOf(k);
        if (idx !== -1 && cells[idx]) return cells[idx];
      }
      return '';
    };

    if (isEmpTable) {
      const id = get('employee_id', 'employee id', 'emp_id');
      const name = cleanStr(get('name', 'employee name'));
      const salRaw = cleanStr(get('salary', 'annual salary', 'compensation', 'ctc'));
      if (id || isValidEntityName(name)) {
        emp.push({
          id,
          name: name || id,
          department: cleanStr(get('department')),
          role: cleanStr(get('role', 'title')),
          status: cleanStr(get('status')),
          salary: parseNumericAmount(salRaw),
          salaryDisplay: salRaw,
        });
      }
    }
    if (isCustTable) {
      const id = get('customer_id', 'customer id');
      const name = cleanStr(get('customer name', 'name', 'account name'));
      const valRaw = cleanStr(get('annual_value', 'annual value', 'arr ($)', 'arr', 'annual_income'));
      if (id || isValidEntityName(name)) {
        cust.push({
          id,
          name: name || id,
          city: cleanStr(get('city')),
          segment: cleanStr(get('segment', 'tier', 'customer_type')),
          industry: cleanStr(get('industry')),
          status: cleanStr(get('status', 'account_status')),
          annualValue: parseNumericAmount(valRaw),
          valueDisplay: valRaw,
        });
      }
    }
    if (isVendTable) {
      const vn = cleanStr(get('vendor name', 'vendor', 'merchant'));
      if (isValidEntityName(vn)) vend.push({ name: vn });
    }
  }

  // 2. Key-value / Profile documents
  if (fnLow.includes('employee') || fnLow.includes('emp-') || pathLow.includes('/hr/') || pathLow.includes('\\hr\\') || headLow.includes('employee profile') || headLow.includes('employment agreement')) {
    const eidM = text.match(/(?:Employee\s*ID|Contract\s*ID)\s*[:\n\-]\s*([A-Za-z0-9-]+)/i);
    const nameM = text.match(/(?:^|\n)(?:Name|Employee)\s*[:\n\-]\s*([^\n|]+)/i);
    const deptM = text.match(/Department\s*[:\n\-]\s*([^\n|]+)/i);
    const roleM = text.match(/Role\s*[:\n\-]\s*([^\n|]+)/i);
    const statM = text.match(/(?:Employment\s*Status|Status)\s*[:\n\-]\s*([^\n|]+)/i);
    const salM = text.match(/(?:Annual\s*Salary|Annual\s*Compensation|Salary|Compensation|CTC)\s*[:\n\-]\s*([^\n|]+)/i);
    const eid = eidM ? eidM[1].trim() : '';
    let name = nameM ? cleanStr(nameM[1]) : '';
    if (name.toUpperCase().startsWith('EMP-')) name = '';
    const salRaw = salM ? cleanStr(salM[1]) : '';
    if (eid || isValidEntityName(name)) {
      emp.push({
        id: eid,
        name: name || eid,
        department: deptM ? cleanStr(deptM[1]) : '',
        role: roleM ? cleanStr(roleM[1]) : '',
        status: statM ? cleanStr(statM[1]) : '',
        salary: parseNumericAmount(salRaw),
        salaryDisplay: salRaw,
      });
    }
  }

  if (fnLow.includes('customer') || fnLow.includes('invoice') || fnLow.includes('contract') || headLow.includes('customer profile') || headLow.includes('customer record')) {
    const cidM = text.match(/Customer\s*ID\s*[:\n\-]\s*([A-Za-z0-9-]+)/i);
    const cnameM = text.match(/(?:^|\n)(?:Customer\s*Name|Customer|Bill\s*To|Client|Name)\s*[:\n\-]\s*([^\n|]+)/i);
    const cityM = text.match(/City\s*[:\n\-]\s*([^\n|]+)/i);
    const segM = text.match(/Segment\s*[:\n\-]\s*([^\n|;]+)/i);
    const indM = text.match(/Industry\s*[:\n\-]\s*([^\n|]+)/i);
    const statM = text.match(/(?:Account\s*Status|Status)\s*[:\n\-]\s*([^\n|]+)/i);
    const valM = text.match(/(?:Annual\s*Value|ARR|Account\s*value)\s*[:\n\-]\s*([^\n|]+)/i);
    const cid = cidM ? cidM[1].trim() : '';
    const cname = cnameM ? cleanStr(cnameM[1]) : '';
    const valRaw = valM ? cleanStr(valM[1]) : '';
    if (cid || isValidEntityName(cname)) {
      cust.push({
        id: cid,
        name: cname || cid,
        city: cityM ? cleanStr(cityM[1]) : '',
        segment: segM ? cleanStr(segM[1]) : '',
        industry: indM ? cleanStr(indM[1]) : '',
        status: statM ? cleanStr(statM[1]) : '',
        annualValue: parseNumericAmount(valRaw),
        valueDisplay: valRaw,
      });
    }
  }

  if (text.toLowerCase().includes('vendor') || fnLow.includes('invoice')) {
    const vm = text.match(/(?:Vendor\s*(?:Name)?|Provider)\s*[:\n\-]\s*([^\n|]+)/i);
    if (vm && isValidEntityName(cleanStr(vm[1]))) vend.push({ name: cleanStr(vm[1]) });
  }

  return { emp, cust, vend };
}

// ---------------------------------------------------------------------------
// Persistent & In-Memory Desktop Folder Index Manager
// ---------------------------------------------------------------------------
class DesktopSearchEngine {
  constructor(cacheDir = null) {
    this.cacheDir = cacheDir || null;
    this.indexes = new Map(); // rootResolved -> { entries: Map<relPath, Record>, lastBuiltAt, buildingPromise }
    this.watchers = new Map();
  }

  setCacheDir(dir) {
    this.cacheDir = dir;
  }

  _closeWatcher(rootResolved) {
    const existing = this.watchers.get(rootResolved);
    if (!existing) return;
    try {
      existing.close();
    } catch {
      // ignore
    }
    this.watchers.delete(rootResolved);
  }

  _ensureWatched(rootResolved) {
    if (this.watchers.has(rootResolved)) return;
    const state = this.indexes.get(rootResolved);
    if (state && state.entries.size > 2500) return;
    try {
      const watcher = fs.watch(rootResolved, { recursive: true }, (_eventType, filename) => {
        if (!filename) return;
        const base = path.basename(filename);
        if (base.startsWith('~$') || base.endsWith('.tmp') || base.endsWith('_index.json')) return;
        const st = this.indexes.get(rootResolved);
        if (!st) return;
        if (st.entries.size > 2500) {
          this._closeWatcher(rootResolved);
          return;
        }
        st.lastScanAt = 0;
      });
      watcher.on('error', () => {});
      this.watchers.set(rootResolved, watcher);
    } catch {
      // ignore on platforms/filesystems without recursive watch support
    }
  }

  closeWatchers() {
    for (const watcher of this.watchers.values()) {
      try {
        watcher.close();
      } catch {
        // ignore
      }
    }
    this.watchers.clear();
  }

  _cacheFilePath(rootResolved) {
    if (!this.cacheDir) return null;
    const hash = crypto.createHash('sha1').update(rootResolved.toLowerCase()).digest('hex').slice(0, 16);
    return path.join(this.cacheDir, `folder-index-v3-${hash}.json`);
  }

  _parseCacheContentToMap(raw, rootResolved, maxItems = Infinity) {
    const m = new Map();
    if (!raw) return m;
    const trimmed = raw.trimStart();
    // Format v3: newline-delimited JSON header + items for fast streaming / chunked loads
    if (trimmed.startsWith('{"version":3,')) {
      const lines = raw.split('\n');
      let headerOk = false;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          if (!headerOk) {
            if (obj && obj.version === 3 && obj.root === rootResolved) {
              headerOk = true;
              continue;
            }
            return null;
          }
          if (obj && obj.relPath) {
            m.set(obj.relPath, obj);
            if (m.size >= maxItems) break;
          }
        } catch {
          // skip corrupt line
        }
      }
      return headerOk ? m : null;
    }
    const parsed = JSON.parse(raw);
    if (parsed && parsed.root === rootResolved && Array.isArray(parsed.items)) {
      for (const it of parsed.items) {
        if (it && it.relPath) {
          m.set(it.relPath, it);
          if (m.size >= maxItems) break;
        }
      }
      return m;
    }
    return null;
  }

  _loadDiskCache(rootResolved) {
    const cp = this._cacheFilePath(rootResolved);
    if (!cp || !fs.existsSync(cp)) return null;
    try {
      const st = fs.statSync(cp);
      // Avoid multi-second synchronous JSON.parse on giant legacy caches during sync cold call;
      // async warmup loads full cache cleanly off-tick.
      if (st.size > 10 * 1024 * 1024) return null;
      const raw = fs.readFileSync(cp, 'utf8');
      return this._parseCacheContentToMap(raw, rootResolved);
    } catch {
      return null;
    }
  }

  async _loadDiskCacheAsync(rootResolved) {
    const cp = this._cacheFilePath(rootResolved);
    if (!cp) return null;
    try {
      const st = await fs.promises.stat(cp);
      if (st.size > 128 * 1024 * 1024) return null;
      const raw = await fs.promises.readFile(cp, 'utf8');
      const trimmed = raw.trimStart();
      if (trimmed.startsWith('{"version":3,')) {
        const m = new Map();
        const lines = raw.split('\n');
        let headerOk = false;
        let sliceStart = Date.now();
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;
          try {
            const obj = JSON.parse(line);
            if (!headerOk) {
              if (obj && obj.version === 3 && obj.root === rootResolved) {
                headerOk = true;
                continue;
              }
              return null;
            }
            if (obj && obj.relPath) m.set(obj.relPath, obj);
          } catch {
            // skip corrupt line
          }
          if (i % 400 === 0 && Date.now() - sliceStart >= 10) {
            await new Promise((r) => setImmediate(r));
            sliceStart = Date.now();
          }
        }
        return headerOk ? m : null;
      }
      return this._parseCacheContentToMap(raw, rootResolved);
    } catch {
      return null;
    }
  }

  _compactCacheEntry(it, isLargeRoot) {
    let semanticVec = it.semanticVec || {};
    if (isLargeRoot && semanticVec && typeof semanticVec === 'object') {
      const topEntries = Object.entries(semanticVec)
        .filter(([k]) => !k.startsWith('g:'))
        .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
        .slice(0, 48);
      semanticVec = Object.fromEntries(topEntries);
    }
    return {
      relPath: it.relPath,
      fullPath: it.fullPath,
      name: it.name,
      ext: it.ext,
      category: it.category,
      size: it.size,
      mtimeMs: it.mtimeMs,
      text: it.text ? String(it.text).slice(0, isLargeRoot ? 800 : 1500) : '',
      invoices: it.invoices || [],
      entities: it.entities || [],
      semanticVec,
    };
  }

  _saveDiskCache(rootResolved, entriesMap) {
    const cp = this._cacheFilePath(rootResolved);
    if (!cp) return;
    try {
      fs.mkdirSync(path.dirname(cp), { recursive: true });
      const isLargeRoot = entriesMap.size > 1500;
      const header = JSON.stringify({ version: 3, root: rootResolved, savedAt: Date.now(), count: entriesMap.size });
      const lines = [header];
      for (const it of entriesMap.values()) {
        lines.push(JSON.stringify(this._compactCacheEntry(it, isLargeRoot)));
      }
      fs.writeFileSync(cp, lines.join('\n'), 'utf8');
    } catch {
      // non-fatal
    }
  }

  async _saveDiskCacheAsync(rootResolved, entriesMap) {
    const cp = this._cacheFilePath(rootResolved);
    if (!cp) return;
    const tmpCp = `${cp}.${process.pid}.tmp`;
    try {
      await fs.promises.mkdir(path.dirname(cp), { recursive: true });
      const isLargeRoot = entriesMap.size > 1500;
      const header = JSON.stringify({ version: 3, root: rootResolved, savedAt: Date.now(), count: entriesMap.size });
      const handle = await fs.promises.open(tmpCp, 'w');
      try {
        await handle.write(header + '\n', null, 'utf8');
        let chunk = [];
        let sliceStart = Date.now();
        for (const it of entriesMap.values()) {
          chunk.push(JSON.stringify(this._compactCacheEntry(it, isLargeRoot)));
          if (chunk.length >= 250) {
            await handle.write(chunk.join('\n') + '\n', null, 'utf8');
            chunk = [];
            if (Date.now() - sliceStart >= 10) {
              await new Promise((r) => setImmediate(r));
              sliceStart = Date.now();
            }
          }
        }
        if (chunk.length > 0) {
          await handle.write(chunk.join('\n') + '\n', null, 'utf8');
        }
      } finally {
        await handle.close();
      }
      await fs.promises.rename(tmpCp, cp);
    } catch {
      try { await fs.promises.unlink(tmpCp); } catch {}
    }
  }

  _collectDiskFiles(rootResolved, maxFiles = 25000, budgetMs = 0) {
    const files = [];
    const stack = [{ dir: rootResolved, depth: 0 }];
    const visitedDirs = new Set([rootResolved.toLowerCase()]);
    const startedAt = budgetMs > 0 ? Date.now() : 0;
    while (stack.length && files.length < maxFiles) {
      if (budgetMs > 0 && Date.now() - startedAt >= budgetMs) break;
      const { dir: cur, depth } = stack.pop();
      let dirEntries;
      try {
        dirEntries = fs.readdirSync(cur, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of dirEntries) {
        if (files.length >= maxFiles) break;
        if (budgetMs > 0 && Date.now() - startedAt >= budgetMs) break;
        const name = entry.name;
        if (!name || name.startsWith('.') || name.startsWith('$') || name.startsWith('~$')) continue;
        if (typeof entry.isSymbolicLink === 'function' && entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (depth >= 22 || SKIP_DIRS.has(name.toLowerCase())) continue;
          const child = path.join(cur, name);
          const childKey = child.toLowerCase();
          if (visitedDirs.has(childKey)) continue;
          visitedDirs.add(childKey);
          stack.push({ dir: child, depth: depth + 1 });
          continue;
        }
        if (!entry.isFile()) continue;
        const fullPath = path.join(cur, name);
        const lowName = name.toLowerCase();
        if (lowName.endsWith('_index.json') || lowName === 'desktop.ini' || lowName === 'thumbs.db') continue;
        const ext = path.extname(name).toLowerCase();
        if (!SUPPORTED_EXTS.has(ext) && ext !== '') continue;
        try {
          const st = fs.statSync(fullPath);
          const relPath = path.relative(rootResolved, fullPath).replace(/\\/g, '/');
          files.push({ fullPath, relPath, name, ext, size: st.size, mtimeMs: st.mtimeMs });
        } catch {
          // ignore
        }
      }
    }
    return files;
  }

  async _collectDiskFilesAsync(rootResolved, maxFiles = 35000) {
    const files = [];
    const stack = [{ dir: rootResolved, depth: 0 }];
    const visitedDirs = new Set([rootResolved.toLowerCase()]);
    let sliceStart = Date.now();
    let seenEntries = 0;

    while (stack.length && files.length < maxFiles) {
      const { dir: cur, depth } = stack.pop();
      let dirEntries;
      try {
        dirEntries = await fs.promises.readdir(cur, { withFileTypes: true });
      } catch {
        continue;
      }
      const statQueue = [];
      for (const entry of dirEntries) {
        if (files.length + statQueue.length >= maxFiles) break;
        seenEntries++;
        const name = entry.name;
        if (!name || name.startsWith('.') || name.startsWith('$') || name.startsWith('~$')) continue;
        if (typeof entry.isSymbolicLink === 'function' && entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (depth >= 22 || SKIP_DIRS.has(name.toLowerCase())) continue;
          const child = path.join(cur, name);
          const childKey = child.toLowerCase();
          if (visitedDirs.has(childKey)) continue;
          visitedDirs.add(childKey);
          stack.push({ dir: child, depth: depth + 1 });
          continue;
        }
        if (!entry.isFile()) continue;
        const lowName = name.toLowerCase();
        if (lowName.endsWith('_index.json') || lowName === 'desktop.ini' || lowName === 'thumbs.db') continue;
        const ext = path.extname(name).toLowerCase();
        if (!SUPPORTED_EXTS.has(ext) && ext !== '') continue;
        const fullPath = path.join(cur, name);
        statQueue.push({ fullPath, name, ext });
      }
      if (statQueue.length > 0) {
        const CONCURRENCY = 16;
        for (let i = 0; i < statQueue.length && files.length < maxFiles; i += CONCURRENCY) {
          const batch = statQueue.slice(i, i + CONCURRENCY);
          const settled = await Promise.all(
            batch.map(async (item) => {
              try {
                const st = await fs.promises.lstat(item.fullPath);
                if (st.isSymbolicLink() || !st.isFile()) return null;
                const relPath = path.relative(rootResolved, item.fullPath).replace(/\\/g, '/');
                return { fullPath: item.fullPath, relPath, name: item.name, ext: item.ext, size: st.size, mtimeMs: st.mtimeMs };
              } catch {
                return null;
              }
            })
          );
          for (const rec of settled) {
            if (rec && files.length < maxFiles) files.push(rec);
          }
          if (Date.now() - sliceStart >= 10) {
            await new Promise((r) => setImmediate(r));
            sliceStart = Date.now();
          }
        }
      } else if (seenEntries >= 80 && Date.now() - sliceStart >= 10) {
        await new Promise((r) => setImmediate(r));
        sliceStart = Date.now();
        seenEntries = 0;
      }
    }
    return files;
  }

  _buildRecordFromText(diskFile, text) {
    const trimmedText = text;
    const category = diskFile.relPath.includes('/') ? diskFile.relPath.split('/')[0] : 'General';
    const invoices = extractInvoicesFromText(diskFile.name, diskFile.relPath, diskFile.fullPath, trimmedText);
    const entities = extractEntitiesFromDocument(diskFile.name, diskFile.relPath, trimmedText);
    const fnSpaced = diskFile.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
    const semanticVec = buildSparseSemanticVector(`${fnSpaced} ${category} ${trimmedText.slice(0, 3500)}`, true);

    return {
      relPath: diskFile.relPath,
      fullPath: diskFile.fullPath,
      name: diskFile.name,
      ext: diskFile.ext,
      category,
      size: diskFile.size,
      mtimeMs: diskFile.mtimeMs,
      text: trimmedText,
      invoices,
      entities,
      semanticVec,
    };
  }

  _buildRecord(diskFile) {
    const text = extractFileTextNode(diskFile.fullPath, diskFile.ext, diskFile.size);
    return this._buildRecordFromText(diskFile, text);
  }

  async _buildRecordAsync(diskFile) {
    const text = await extractFileTextNodeAsync(diskFile.fullPath, diskFile.ext, diskFile.size);
    return this._buildRecordFromText(diskFile, text);
  }

  ensureIndexedSync(rootResolved) {
    let state = this.indexes.get(rootResolved);
    if (!state) {
      const diskLoaded = this._loadDiskCache(rootResolved);
      state = { entries: diskLoaded || new Map(), lastScanAt: 0, buildingPromise: null };
      this.indexes.set(rootResolved, state);
    }
    this._ensureWatched(rootResolved);
    const now = Date.now();
    // Non-blocking query path: if entries already exist in memory or disk cache, return immediately
    if (state.entries.size > 0) {
      if (state.entries.size > 2500) {
        this._closeWatcher(rootResolved);
      }
      if (now - state.lastScanAt > 60000 && !state.buildingPromise) {
        this.warmIndexAsync(rootResolved).catch(() => {});
      }
      return state;
    }

    // If completely empty on first launch, start background async building and index a tightly bounded initial slice
    if (!state.buildingPromise) {
      this.warmIndexAsync(rootResolved).catch(() => {});
    }

    const diskFiles = this._collectDiskFiles(rootResolved, 120, 180);
    const syncDeadline = Date.now() + 200;
    for (const df of diskFiles) {
      state.entries.set(df.relPath, this._buildRecord(df));
      if (Date.now() >= syncDeadline) break;
    }
    state.lastScanAt = now;
    return state;
  }

  async warmIndexAsync(rootResolved) {
    let state = this.indexes.get(rootResolved);
    if (state?.buildingPromise) return state.buildingPromise;
    if (!state) {
      state = { entries: new Map(), lastScanAt: 0, buildingPromise: null };
      this.indexes.set(rootResolved, state);
    }

    state.buildingPromise = (async () => {
      try {
        if (state.entries.size === 0) {
          const diskLoaded = await this._loadDiskCacheAsync(rootResolved);
          if (diskLoaded && diskLoaded.size > 0) {
            state.entries = diskLoaded;
          }
        }
        const diskFiles = await this._collectDiskFilesAsync(rootResolved, 35000);
        if (diskFiles.length > 2500) {
          this._closeWatcher(rootResolved);
        }
        const liveRels = new Set();
        let changed = false;
        let checked = 0;
        let sliceStart = Date.now();

        for (const df of diskFiles) {
          liveRels.add(df.relPath);
          checked++;
          const cached = state.entries.get(df.relPath);
          if (cached && cached.mtimeMs === df.mtimeMs && cached.size === df.size && cached.semanticVec) {
            if (checked % 150 === 0 && Date.now() - sliceStart >= 10) {
              await new Promise((r) => setImmediate(r));
              sliceStart = Date.now();
            }
            continue;
          }
          state.entries.set(df.relPath, await this._buildRecordAsync(df));
          changed = true;
          if (Date.now() - sliceStart >= 10) {
            await new Promise((r) => setImmediate(r));
            sliceStart = Date.now();
          }
        }
        for (const oldKey of Array.from(state.entries.keys())) {
          if (!liveRels.has(oldKey)) {
            state.entries.delete(oldKey);
            changed = true;
          }
        }
        state.lastScanAt = Date.now();
        if (changed) await this._saveDiskCacheAsync(rootResolved, state.entries);
        return state.entries.size;
      } finally {
        state.buildingPromise = null;
      }
    })();
    return state.buildingPromise;
  }

  _computeFolderStats(entries) {
    const categories = {};
    for (const rec of entries.values()) {
      categories[rec.category] = (categories[rec.category] || 0) + 1;
    }
    return { total_files: entries.size, categories };
  }

  _aggregateEntities(entries, entityKind) {
    const empMap = new Map();
    const custMap = new Map();
    const vendMap = new Map();
    const empFiles = new Set();
    const custFiles = new Set();
    const vendFiles = new Set();

    const addItem = (map, key, item, relPath) => {
      const nk = String(key || '').trim().toUpperCase();
      if (!nk) return;
      const prev = map.get(nk);
      if (!prev) {
        map.set(nk, { ...item, files: [relPath] });
      } else {
        for (const [k, v] of Object.entries(item)) {
          if (v && !prev[k]) prev[k] = v;
        }
        if (prev.files.length < 8 && !prev.files.includes(relPath)) prev.files.push(relPath);
      }
    };

    for (const rec of entries.values()) {
      const ents = rec.entities || {};
      if (entityKind === 'all' || entityKind === 'employees') {
        for (const e of ents.emp || []) {
          empFiles.add(rec.fullPath);
          addItem(empMap, e.id || e.name, e, rec.fullPath);
        }
      }
      if (entityKind === 'all' || entityKind === 'customers') {
        for (const c of ents.cust || []) {
          custFiles.add(rec.fullPath);
          addItem(custMap, c.id || c.name, c, rec.fullPath);
        }
      }
      if (entityKind === 'all' || entityKind === 'vendors') {
        for (const v of ents.vend || []) {
          vendFiles.add(rec.fullPath);
          addItem(vendMap, v.name, v, rec.fullPath);
        }
      }
    }

    const summarize = (map, filesSet, groupField) => {
      const vals = Array.from(map.values());
      const breakdown = {};
      const sampleNames = [];
      for (const it of vals) {
        if (sampleNames.length < 25) sampleNames.push(it.name || it.id);
        if (groupField) {
          const g = (it[groupField] || 'Unspecified').trim();
          if (g) breakdown[g] = (breakdown[g] || 0) + 1;
        }
      }
      return {
        total_count: vals.length,
        source_file_count: filesSet.size,
        source_files: Array.from(filesSet).slice(0, 40),
        breakdown,
        sample_names: sampleNames,
        samples: vals.slice(0, 40),
        all_records: vals,
      };
    };

    return {
      scanned_files: entries.size,
      employees: summarize(empMap, empFiles, 'department'),
      customers: summarize(custMap, custFiles, 'segment'),
      vendors: summarize(vendMap, vendFiles, null),
    };
  }

  _filterEntitiesByNumericQuery(entries, numSpec, offset = 0, limit = 25) {
    const agg = this._aggregateEntities(entries, numSpec.domain);
    const bucket = agg[numSpec.domain] || {};
    const allRecords = bucket.all_records || [];
    const field = numSpec.field;
    const op = numSpec.op;
    const matched = [];
    let maxObserved = null;
    let totalWithNumericField = 0;

    for (const item of allRecords) {
      const val = item[field];
      if (typeof val !== 'number' || !Number.isFinite(val)) continue;
      if (numSpec.deptFilter) {
        const dLow = String(item.department || item.segment || '').toLowerCase();
        const rLow = String(item.role || '').toLowerCase();
        if (!dLow.includes(numSpec.deptFilter) && !rLow.includes(numSpec.deptFilter)) continue;
      }
      if (numSpec.statusFilter) {
        const sLow = String(item.status || item.segment || '').toLowerCase();
        if (!sLow.includes(numSpec.statusFilter)) continue;
      }
      totalWithNumericField++;
      if (maxObserved === null || val > maxObserved) maxObserved = val;

      let keep = false;
      if (op === 'gt' && numSpec.minVal !== null) keep = val > numSpec.minVal;
      else if (op === 'ge' && numSpec.minVal !== null) keep = val >= numSpec.minVal;
      else if (op === 'lt' && numSpec.maxVal !== null) keep = val < numSpec.maxVal;
      else if (op === 'le' && numSpec.maxVal !== null) keep = val <= numSpec.maxVal;
      else if (op === 'between' && numSpec.minVal !== null && numSpec.maxVal !== null) {
        keep = val >= numSpec.minVal && val <= numSpec.maxVal;
      } else if (op === 'rank') {
        keep = true;
      }
      if (keep) matched.push(item);
    }

    matched.sort((a, b) => (numSpec.sortDir === 'asc' ? (a[field] - b[field]) : (b[field] - a[field])));
    const capped = (op === 'rank' && numSpec.topN) ? matched.slice(0, numSpec.topN) : matched;

    const breakdown = {};
    const sourceFileSet = new Set();
    const groupKey = numSpec.domain === 'employees' ? 'department' : 'segment';
    for (const item of capped) {
      const g = (item[groupKey] || '').trim();
      if (g) breakdown[g] = (breakdown[g] || 0) + 1;
      for (const fp of item.files || []) sourceFileSet.add(fp);
    }

    const rowOffset = offset > 0 ? offset * 2 : 0;
    return {
      domain: numSpec.domain,
      field,
      totalScannedRecords: totalWithNumericField,
      totalMatching: capped.length,
      maxObserved,
      breakdown,
      matchedRecords: capped.slice(rowOffset, rowOffset + limit),
      sourceFiles: Array.from(sourceFileSet),
      rowOffset,
    };
  }

  search(rootResolved, query, options = {}) {
    const t0 = Date.now();
    const state = this.ensureIndexedSync(rootResolved);
    const entries = state.entries;
    const topChunksLimit = Number.isFinite(options.topChunksLimit) ? options.topChunksLimit : 8;
    const topFilesLimit = Number.isFinite(options.topFilesLimit) ? options.topFilesLimit : 10;
    const offset = Number.isFinite(options.offset) && options.offset >= 0 ? options.offset : 0;

    const qClean = String(query || '').trim();
    const qLow = qClean.toLowerCase();
    const qSpaced = qLow.replace(/[_-]+/g, ' ');
    const terms = tokenize(qSpaced, true);
    const cleanPhrase = terms.join(' ');
    const queryConcepts = extractConcepts(qClean);
    const queryVec = buildSparseSemanticVector(qClean, true);

    const codeTokens = (qLow.match(/\b[a-z0-9]+(?:[-_][a-z0-9]+)+\b/g) || [])
      .filter((t) => /[a-z]/.test(t) && /\d/.test(t));
    const entityTokens = (qLow.match(/\b(?:customer|employee|project|account|vendor|contract|invoice|bill|task|order)[-_ ]+(\d{1,6}(?:[-_][a-z0-9]+)*)\b/gi) || []);
    for (const em of entityTokens) {
      const parts = em.split(/[-_ ]+/);
      const fullPref = parts[0].toLowerCase();
      const numPart = parts.slice(1).join('-');
      const normMap = {
        customer: 'cust',
        employee: 'emp',
        project: 'prj',
        contract: 'cnt',
        invoice: 'inv',
        purchase: 'pur',
      };
      const shortPref = normMap[fullPref] || fullPref;
      codeTokens.push(em.toLowerCase());
      codeTokens.push(`${shortPref}-${numPart}`);
    }

    const folderStats = this._computeFolderStats(entries);

    // Detect Numeric Filter Query ("list the employees salary more then 10 lacks", "employee salary more then 30lpa")
    const numSpec = parseNumericFilterQuery(qClean);

    // Detect Structured Invoice Query ("already paid", "customres they did'n paid", "2026 invoic", "created on 2026", "overdue")
    const invSpec = (!numSpec && !codeTokens.length) ? parseStructuredInvoiceFilterNode(qClean) : null;

    // Detect Cross-File Aggregation ("how many employees do I have", "what customers do I have")
    const normLow = normalizeQueryTypos(qClean).toLowerCase();
    const asksInventory = /\b(?:how many|total number|total|count of|headcount|what are|who are|list all|all the|do i have|do we have)\b/i.test(normLow);
    let aggKind = null;
    if (!numSpec && !invSpec && asksInventory) {
      if (/\b(?:employee|employees|staff|worker|workers|headcount|personnel)\b/i.test(normLow)) aggKind = 'employees';
      else if (/\b(?:customer|customers|client|clients)\b/i.test(normLow)) aggKind = 'customers';
      else if (/\b(?:vendor|vendors|supplier|suppliers)\b/i.test(normLow)) aggKind = 'vendors';
    }

    // Detect Structured Overdue Invoice Query ("invoice over due files", "overdue invoices", "past due bills")
    const hasInvoiceIntent = /\b(?:invoice|invoices|bill|bills|billing|payment|payable)\b/i.test(normLow);
    const hasOverdueIntent = /\b(?:overdue|over due|past due|late|unpaid|missed due|expired)\b/i.test(normLow);
    const isOverdueQuery = !codeTokens.length && (Boolean(invSpec) || (hasInvoiceIntent && hasOverdueIntent));

    let structuredSummary = '';
    let aggregatedEntities = null;
    const specialScoredFiles = [];
    let isStrictZeroNumericMatch = false;

    if (numSpec) {
      const fRes = this._filterEntitiesByNumericQuery(entries, numSpec, offset, 25);
      if (fRes.totalMatching > 0) {
        const bdStr = Object.entries(fRes.breakdown).slice(0, 8).map(([k, v]) => `${k}: ${v}`).join(', ');
        const bdStr = Object.entries(fRes.breakdown).slice(0, 5).map(([k, v]) => `${k}: ${v}`).join(', ');
        const lblField = fRes.field === 'annualValue' ? 'Annual Value' : 'Salary';
        const lines = [
          `Evaluated ${fRes.totalScannedRecords} unique ${fRes.domain} records across ${entries.size} connected files: ` +
          `found **${fRes.totalMatching} unique ${fRes.domain}** matching your ${lblField.toLowerCase()} condition` +
          (bdStr ? ` (Department/Segment breakdown: ${bdStr})` : '') + '.',
          `Showing ${fRes.rowOffset + 1}–${fRes.rowOffset + fRes.matchedRecords.length} of ${fRes.totalMatching} qualifying ${fRes.domain} (sorted by ${lblField.toLowerCase()}):`,
          `Found **${fRes.totalMatching} ${fRes.domain}** matching your ${lblField.toLowerCase()} condition` +
          (bdStr ? ` (${bdStr})` : '') + '.',
        ];
        if (fRes.totalMatching > 5) {
          lines.push('**Key Highlights**');
        }
        const byPath = new Map();
        for (const r of entries.values()) byPath.set(r.fullPath, r);
        for (const rec of fRes.matchedRecords) {
        for (const rec of fRes.matchedRecords.slice(0, 5)) {
          const valRaw = rec[fRes.field];
          const valStr = Number.isFinite(valRaw) ? valRaw.toLocaleString('en-IN') : (rec.salaryDisplay || rec.valueDisplay || '');
          const meta = [rec.id, rec.department || rec.segment, rec.role, rec.status].filter(Boolean).join(' · ');
          const srcRel = rec.files?.[0] ? (byPath.get(rec.files[0])?.relPath || path.basename(rec.files[0])) : '';
          lines.push(`- **${rec.name || rec.id}** (${meta}) — ${lblField}: **${valStr}**${srcRel ? ` · File: ${srcRel}` : ''}`);
          const metaShort = [rec.id, rec.department || rec.segment].filter(Boolean).join(' · ');
          const srcName = rec.files?.[0] ? path.basename(byPath.get(rec.files[0])?.relPath || rec.files[0]) : '';
          lines.push(`• **${rec.name || rec.id}**${metaShort ? ` (${metaShort})` : ''} · **${valStr}**${srcName ? ` (\`${srcName}\`)` : ''}`);
        }
        if (fRes.totalMatching > fRes.rowOffset + fRes.matchedRecords.length) {
          lines.push(`*${fRes.totalMatching - (fRes.rowOffset + fRes.matchedRecords.length)} more qualifying ${fRes.domain} exist — say "I need more" or specify a department (e.g. Engineering, Finance) to narrow down.*`);
        if (fRes.matchedRecords.length > 5) {
          lines.push('');
          lines.push(`| Name | ID | Department | Role | ${lblField} | Source |`);
          lines.push('| --- | --- | --- | --- | --- | --- |');
          for (const rec of fRes.matchedRecords.slice(0, 25)) {
            const valRaw = rec[fRes.field];
            const valStr = Number.isFinite(valRaw) ? valRaw.toLocaleString('en-IN') : (rec.salaryDisplay || rec.valueDisplay || '—');
            const srcName = rec.files?.[0] ? path.basename(byPath.get(rec.files[0])?.relPath || rec.files[0]) : '—';
            const cleanCell = (v) => String(v || '—').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
            lines.push(`| ${cleanCell(rec.name || rec.id)} | ${cleanCell(rec.id)} | ${cleanCell(rec.department || rec.segment)} | ${cleanCell(rec.role)} | ${cleanCell(valStr)} | ${cleanCell(srcName)} |`);
          }
        } else if (fRes.totalMatching > fRes.rowOffset + fRes.matchedRecords.length) {
          lines.push(`*${fRes.totalMatching - (fRes.rowOffset + fRes.matchedRecords.length)} more qualifying ${fRes.domain} exist — say "I need more" to see more.*`);
        }
        structuredSummary = lines.join('\n');
        for (const fp of fRes.sourceFiles) {
          const rec = byPath.get(fp);
          if (rec) {
            const sampleMatches = fRes.matchedRecords.filter((m) => m.files?.includes(fp)).slice(0, 3);
            const snip = sampleMatches.length
              ? sampleMatches.map((m) => `${m.id || m.name} (${m.department || m.role || ''}): ${Number(m[fRes.field]).toLocaleString('en-IN')}`).join(' · ')
              : rec.text.slice(0, 320);
            specialScoredFiles.push({ score: 700, rec, snippet: snip, matchType: 'content' });
          }
        }
      } else if (fRes.totalScannedRecords > 0 || numSpec.deptFilter || numSpec.statusFilter) {
        isStrictZeroNumericMatch = true;
        const maxStr = fRes.maxObserved !== null ? fRes.maxObserved.toLocaleString('en-IN') : 'N/A';
        structuredSummary = fRes.totalScannedRecords > 0
          ? `Searched all **${fRes.totalScannedRecords} unique ${fRes.domain}** records across connected files and found **0 matches** for your numeric filter ` +
            `(highest recorded ${fRes.field === 'annualValue' ? 'annual value' : 'salary'}: **${maxStr}**).`
          : `No ${fRes.domain} records matched your filter (${[numSpec.statusFilter, numSpec.deptFilter].filter(Boolean).join(' / ')}) across connected files.`;
      }
    } else if (aggKind) {
      aggregatedEntities = this._aggregateEntities(entries, aggKind);
      const bucket = aggregatedEntities[aggKind];
      if (bucket && bucket.total_count > 0) {
        const bdStr = Object.entries(bucket.breakdown || {}).slice(0, 8).map(([k, v]) => `${k}: ${v}`).join(', ');
        structuredSummary =
          `Across all ${bucket.source_file_count} matching files (out of ${entries.size} total connected files), ` +
          `found **${bucket.total_count} unique ${aggKind}**` +
          (bdStr ? ` (${bdStr})` : '') +
          `. Samples: ${(bucket.sample_names || []).slice(0, 15).join(', ')}.`;
        const byPath = new Map();
        for (const r of entries.values()) byPath.set(r.fullPath, r);
        const sortedFiles = (bucket.source_files || [])
          .map((fp) => byPath.get(fp))
          .filter(Boolean)
          .sort((a, b) => {
            const pa = (a.relPath || '').toLowerCase();
            const pb = (b.relPath || '').toLowerCase();
            const scorePath = (p) => {
              if (aggKind === 'customers') return (p.includes('customer') ? 10 : 0) + (p.includes('directory') ? 5 : 0);
              if (aggKind === 'employees') return (p.includes('/hr/') || p.includes('employee') ? 10 : 0) + (p.includes('employee_data') || p.includes('profile') ? 5 : 0);
              if (aggKind === 'vendors') return (p.includes('vendor') ? 10 : 0) + (p.includes('invoice') ? 5 : 0);
              return 0;
            };
            return scorePath(pb) - scorePath(pa);
          });
        for (const rec of sortedFiles) {
          specialScoredFiles.push({ score: 500, rec, snippet: rec.text.slice(0, 320), matchType: 'content' });
        }
      }
    } else if (isOverdueQuery) {
      const effSpec = invSpec || { statusFilter: 'overdue', year: null, groupBy: null, entityFilter: null };
      const byIdAll = new Map();
      for (const rec of entries.values()) {
        for (const inv of rec.invoices || []) {
          const fresh = evaluateOverdue(inv.rawStatus || inv.status, inv.invoiceDate, inv.dueDate, inv.paymentTerms);
          const merged = { ...inv, ...fresh, rec };
          const prev = byIdAll.get(merged.id);
          if (!prev || rec.relPath.split('/').length < prev.rec.relPath.split('/').length) {
            byIdAll.set(merged.id, merged);
          }
        }
      }
      const allInvs = Array.from(byIdAll.values());
      const entityInvs = effSpec.entityFilter
        ? allInvs.filter((m) => matchesInvoiceEntityNode(m, effSpec.entityFilter))
        : allInvs;
      let matchedInvs = entityInvs.filter((m) => {
        if (!matchesInvoiceStatusNode(m.status, effSpec.statusFilter, m.isOverdue)) return false;
        if (effSpec.year) {
          const refDt = String(m.invoiceDate || m.dueDate || '');
          if (!refDt.startsWith(`${effSpec.year}-`)) return false;
        }
        return true;
      });
      if (effSpec.groupBy === 'customers') {
        const onlyExplicitCust = matchedInvs.filter((m) => m.hasExplicitCustomer);
        if (onlyExplicitCust.length) matchedInvs = onlyExplicitCust;
      }
      matchedInvs.sort((a, b) => (b.daysOverdue || 0) - (a.daysOverdue || 0));

      const fmtInvAmountNode = (raw) => {
        const s = String(raw || '').trim();
        if (!s) return '—';
        if (/^\d+(?:\.\d+)?$/.test(s)) {
          const n = Number(s);
          if (Number.isFinite(n)) {
            return n.toLocaleString(undefined, {
              minimumFractionDigits: s.includes('.') ? 2 : 0,
              maximumFractionDigits: s.includes('.') ? 2 : 0,
            });
          }
        }
        return s;
      };
      const cleanCellNode = (v) => String(v || '—').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();

      if (matchedInvs.length > 0) {
        if (effSpec.groupBy === 'customers') {
          const custGroups = new Map();
          for (const m of matchedInvs) {
            const k = m.customer || m.vendor || 'Unknown Customer';
            if (!custGroups.has(k)) custGroups.set(k, []);
            custGroups.get(k).push(m);
          }
          const summaryLines = [`Found **${custGroups.size} unique customers** with unpaid / overdue invoices (**${matchedInvs.length}** total invoice records):`];
          for (const cname of Array.from(custGroups.keys()).sort()) {
          const summaryLines = [
            `Found **${custGroups.size} customer${custGroups.size !== 1 ? 's' : ''}** with unpaid / overdue invoices (**${matchedInvs.length}** total):`,
          ];
          for (const cname of Array.from(custGroups.keys()).sort().slice(0, 6)) {
            const items = custGroups.get(cname);
            const totalAmt = items.reduce((s, x) => s + (parseNumericAmount(x.amount) || 0), 0);
            const invDesc = items.slice(0, 6).map((x) => `\`${x.id}\` (${x.status}, ${x.invoiceDate || ''}, ${x.amount})`).join(', ');
            summaryLines.push(`- **${cname}** — **${items.length}** invoice(s) · Total Due: **${totalAmt > 0 ? totalAmt.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : 'N/A'}** — Invoices: ${invDesc}`);
            const invIds = items.slice(0, 4).map((x) => `\`${x.id}\``).join(', ') + (items.length > 4 ? ` +${items.length - 4} more` : '');
            summaryLines.push(`• **${cname}** — **${items.length}** invoice${items.length !== 1 ? 's' : ''} · Total Due: **${totalAmt > 0 ? totalAmt.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : 'N/A'}** (${invIds})`);
          }
          if (custGroups.size > 6 || matchedInvs.length > 5) {
            summaryLines.push('');
            summaryLines.push('| Customer | Invoice | Amount | Status | Date | Source |');
            summaryLines.push('| --- | --- | --- | --- | --- | --- |');
            for (const m of matchedInvs.slice(0, 50)) {
              const dt = m.dueDate || m.invoiceDate || '—';
              const src = path.basename(m.rec?.relPath || m.rec?.name || '');
              summaryLines.push(`| ${cleanCellNode(m.customer || m.vendor)} | ${cleanCellNode(m.id)} | ${cleanCellNode(fmtInvAmountNode(m.amount))} | ${cleanCellNode(m.status)} | ${cleanCellNode(dt)} | ${cleanCellNode(src)} |`);
            }
          }
          structuredSummary = summaryLines.join('\n');
        } else {
          const entLabel = effSpec.entityFilter ? ` for **${effSpec.entityFilter}**` : '';
          const summaryLines = [`Found **${matchedInvs.length}** verified ${effSpec.statusFilter || ''} ${effSpec.year ? effSpec.year + ' ' : ''}invoice record(s)${entLabel}:`];
          for (let i = 0; i < matchedInvs.length && i < 25; i++) {
          const statusWord = effSpec.statusFilter === 'paid'
            ? 'paid'
            : (effSpec.statusFilter === 'unpaid_all' ? 'unpaid / overdue' : (effSpec.statusFilter || 'matching'));
          const uniqueParties = new Set(
            matchedInvs.map((m) => String(m.customer || m.vendor || '').trim().toLowerCase()).filter(Boolean)
          );
          const years = Array.from(
            new Set(
              matchedInvs
                .map((m) => String(m.invoiceDate || m.dueDate || '').slice(0, 4))
                .filter((y) => /^\d{4}$/.test(y))
            )
          ).sort();
          const yearSpan = !effSpec.year && years.length === 1
            ? ` (${years[0]})`
            : (!effSpec.year && years.length > 1 ? ` (${years[0]}–${years[years.length - 1]})` : '');
          const partyNote = !effSpec.entityFilter && uniqueParties.size > 1
            ? ` across **${uniqueParties.size}** vendors/customers`
            : '';

          const summaryLines = [
            `Found **${matchedInvs.length}** ${effSpec.year ? effSpec.year + ' ' : ''}${statusWord} invoice${matchedInvs.length !== 1 ? 's' : ''}${entLabel}${partyNote}${yearSpan}:`,
          ];
          if (matchedInvs.length > 5) {
            summaryLines.push('**Key Highlights**');
          }
          for (let i = 0; i < matchedInvs.length && i < 5; i++) {
            const inv = matchedInvs[i];
            const dates = [
              inv.invoiceDate ? `Invoice Date: ${inv.invoiceDate}` : '',
              inv.dueDate ? `Due Date: ${inv.dueDate}${inv.daysOverdue ? ` (${inv.daysOverdue}d overdue)` : ''}` : '',
            ].filter(Boolean).join(' · ');
            summaryLines.push(`- **${inv.id}** — ${inv.customer} · Amount: **${inv.amount}** · Status: **${inv.status}**${dates ? ' · ' + dates : ''} · File: \`${inv.rec.relPath}\``);
            const amtDisp = fmtInvAmountNode(inv.amount);
            const srcName = path.basename(inv.rec?.relPath || inv.rec?.name || '');
            let dateDisp = '';
            let statusNote = '';
            if (effSpec.statusFilter === 'paid') {
              dateDisp = inv.invoiceDate || (inv.dueDate ? `Due ${inv.dueDate}` : '');
            } else {
              dateDisp = inv.dueDate
                ? `Due ${inv.dueDate}${inv.daysOverdue ? ` (${inv.daysOverdue}d late)` : ''}`
                : (inv.invoiceDate || '');
              statusNote = inv.status ? ` · ${inv.status}` : '';
            }
            const metaBits = [dateDisp, srcName ? `\`${srcName}\`` : ''].filter(Boolean);
            const metaStr = metaBits.length ? ` (${metaBits.join(' · ')})` : '';
            summaryLines.push(`• **${inv.id}** — ${inv.customer || inv.vendor} · **${amtDisp}**${statusNote}${metaStr}`);
          }
          if (matchedInvs.length > 5) {
            summaryLines.push('');
            if (effSpec.statusFilter === 'paid') {
              summaryLines.push('| Invoice | Party | Amount | Date | Source |');
              summaryLines.push('| --- | --- | --- | --- | --- |');
              for (const inv of matchedInvs.slice(0, 50)) {
                const dt = inv.invoiceDate || inv.dueDate || '—';
                const src = path.basename(inv.rec?.relPath || inv.rec?.name || '');
                summaryLines.push(`| ${cleanCellNode(inv.id)} | ${cleanCellNode(inv.customer || inv.vendor)} | ${cleanCellNode(fmtInvAmountNode(inv.amount))} | ${cleanCellNode(dt)} | ${cleanCellNode(src)} |`);
              }
            } else {
              summaryLines.push('| Invoice | Party | Amount | Status | Date | Source |');
              summaryLines.push('| --- | --- | --- | --- | --- | --- |');
              for (const inv of matchedInvs.slice(0, 50)) {
                const dt = inv.dueDate || inv.invoiceDate || '—';
                const src = path.basename(inv.rec?.relPath || inv.rec?.name || '');
                summaryLines.push(`| ${cleanCellNode(inv.id)} | ${cleanCellNode(inv.customer || inv.vendor)} | ${cleanCellNode(fmtInvAmountNode(inv.amount))} | ${cleanCellNode(inv.status)} | ${cleanCellNode(dt)} | ${cleanCellNode(src)} |`);
              }
            }
          }
          structuredSummary = summaryLines.join('\n');
        }
        const seenPath = new Set();
        for (const inv of matchedInvs) {
          if (!seenPath.has(inv.rec.fullPath)) {
            seenPath.add(inv.rec.fullPath);
            const dates = [
              inv.invoiceDate ? `Inv: ${inv.invoiceDate}` : '',
              inv.dueDate ? `Due: ${inv.dueDate}` : '',
            ].filter(Boolean).join(' · ');
            const snippet = `${inv.id} (${inv.customer}) — ${inv.amount} — ${inv.status}${dates ? ' — ' + dates : ''}`;
            specialScoredFiles.push({ score: 600 + (inv.daysOverdue || 1), rec: inv.rec, snippet, matchType: inv.rec.name.toLowerCase().includes('invoice') ? 'name' : 'content' });
          }
        }
      } else if (effSpec.statusFilter || effSpec.year || effSpec.groupBy) {
        isStrictZeroNumericMatch = true;
        const entLabel = effSpec.entityFilter ? ` for **${effSpec.entityFilter}**` : '';
        let otherNote = '';
        if (effSpec.entityFilter && entityInvs.length > 0) {
          const stCounts = {};
          for (const ei of entityInvs) stCounts[ei.status || 'Unknown'] = (stCounts[ei.status || 'Unknown'] || 0) + 1;
          otherNote = ` *(Note: Found **${entityInvs.length}** other invoice(s) on file for **${effSpec.entityFilter}** — ${Object.entries(stCounts).map(([k, v]) => `${k}: ${v}`).join(', ')}.)*`;
        }
        structuredSummary = `No matching ${effSpec.statusFilter || ''} ${effSpec.year ? effSpec.year + ' ' : ''}invoice records${entLabel} were found across indexed company documents.${otherNote}`;
      }
    }

    // Standard + Hybrid Semantic Ranking across all indexed records
    let rankedFiles = [];
    const rankedChunks = [];

    if (specialScoredFiles.length > 0 && (numSpec || isOverdueQuery || aggKind)) {
      for (const item of specialScoredFiles) {
        rankedFiles.push({
          score: item.score,
          name: item.rec.name,
          path: item.rec.fullPath,
          full_path: item.rec.fullPath,
          display_path: item.rec.relPath,
          type: item.rec.ext.replace(/^\./, '') || 'file',
          open_url: item.rec.fullPath,
          source: 'local',
          match_type: item.matchType,
          content_snippet: item.snippet,
          relPath: item.rec.relPath,
          rawText: item.rec.text,
        });
      }
    }

    const isBrowseAll = !terms.length && !codeTokens.length && (
      qLow.includes('folder') || qLow.includes('files') || qLow.includes('documents') || qLow.includes('all') || !qClean
    );

    if (!isStrictZeroNumericMatch && (!numSpec || !rankedFiles.length) && (!isOverdueQuery || !rankedFiles.length)) {
      const constraints = parseQueryConstraintsNode(qClean);
      const isAlt = constraints.isAlternation;
      const isMulti = !isAlt && constraints.branches.length === 1 && constraints.branches[0].length >= 2;
      const matchedBranchSet = new Set();
      const partialGroupSet = new Set();
      const seenPaths = new Set(rankedFiles.map((f) => f.full_path));
      for (const rec of entries.values()) {
        if (seenPaths.has(rec.fullPath)) continue;
        if (isBrowseAll) {
          rankedFiles.push({
            score: 100 + (rec.mtimeMs || 0) / 1e13,
            name: rec.name,
            path: rec.fullPath,
            full_path: rec.fullPath,
            display_path: rec.relPath,
            type: rec.ext.replace(/^\./, '') || 'file',
            open_url: rec.fullPath,
            source: 'local',
            match_type: 'name',
            content_snippet: (rec.text || '').slice(0, 320),
            relPath: rec.relPath,
            rawText: rec.text,
          });
          continue;
        }
        if (!terms.length && !codeTokens.length) continue;

        let constraintRes = null;
        if (!codeTokens.length && (isAlt || isMulti)) {
          constraintRes = validateTextAgainstConstraintsNode(rec.name, rec.relPath, rec.text || '', constraints);
          if (constraintRes.valid) {
            for (const bi of constraintRes.matchedBranches) matchedBranchSet.add(bi);
          } else {
            for (const mg of constraintRes.matchedGroups) partialGroupSet.add(mg);
            continue;
          }
        }

        const fnLow = rec.name.toLowerCase();
        const relLow = rec.relPath.toLowerCase();
        const fnStem = fnLow.replace(/\.[^.]+$/, '');
        const fnSpaced = fnStem.replace(/[_-]+/g, ' ');
        const relSpaced = relLow.replace(/[_-]+/g, ' ');
        const txtLow = (rec.text || '').toLowerCase();
        const txtSpaced = txtLow.replace(/[_-]+/g, ' ');

        let score = 0;
        let exactHit = false;
        const matched = new Set();

        // Compound alphanumeric codes with strict boundaries (e.g. NDA-0008, PRJ-CFL-002, INV-2026-0042)
        let exactNameHit = false;
        const tokenMatchedBoundary = (ct, hay) => {
          const esc = ct.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          if (new RegExp(`(?:^|[^a-z0-9])${esc}(?=$|[^a-z0-9])`, 'i').test(hay)) return true;
          const escSp = ct.replace(/[_-]+/g, ' ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          return new RegExp(`(?:^|[^a-z0-9])${escSp}(?=$|[^a-z0-9])`, 'i').test(hay.replace(/[_-]+/g, ' '));
        };
        for (const ct of codeTokens) {
          if (tokenMatchedBoundary(ct, fnLow)) { score += 900; exactHit = true; exactNameHit = true; terms.forEach((t) => matched.add(t)); }
          else if (tokenMatchedBoundary(ct, relLow)) { score += 750; exactHit = true; exactNameHit = true; terms.forEach((t) => matched.add(t)); }
          else if (tokenMatchedBoundary(ct, txtLow)) { score += 600; exactHit = true; terms.forEach((t) => matched.add(t)); }
        }
        if (codeTokens.length && !exactHit) continue;

        // Filename / Phrase bonuses
        if (fnSpaced.length >= 3 && (qLow.includes(fnStem) || qSpaced.includes(fnSpaced) || (cleanPhrase && fnSpaced.includes(cleanPhrase)))) {
          score += 400;
          exactHit = true;
          terms.forEach((t) => matched.add(t));
        }
        if (terms.length > 1 && cleanPhrase) {
          if (relSpaced.includes(cleanPhrase)) { score += 320; exactHit = true; terms.forEach((t) => matched.add(t)); }
          if (txtSpaced.includes(cleanPhrase)) { score += 250; exactHit = true; terms.forEach((t) => matched.add(t)); }
        }

        // Token & Stem matching
        for (const t of terms) {
          const stem = lightStem(t);
          let hit = false;
          if (fnSpaced.includes(t) || (stem.length >= 3 && fnSpaced.includes(stem))) { score += 35; hit = true; }
          if (relSpaced.includes(t) || (stem.length >= 3 && relSpaced.includes(stem))) { score += 16; hit = true; }
          if (txtLow.includes(t) || (stem.length >= 3 && txtLow.includes(stem))) { score += 8; hit = true; }
          if (hit) matched.add(t);
        }

        // Hybrid Semantic Cosine Similarity
        let semSim = 0;
        if (!codeTokens.length && Object.keys(queryVec).length > 0 && rec.semanticVec) {
          semSim = sparseCosineSimilarity(queryVec, rec.semanticVec);
          if (semSim >= 0.24) {
            score += semSim * 75;
          }
        }

        // Relevance gate: require strong token coverage OR strong semantic similarity (or passed compound/OR validation)
        const coverage = terms.length ? matched.size / terms.length : 0;
        const conceptOverlap = queryConcepts.size > 0 && semSim >= 0.28;
        if (!constraintRes?.valid) {
          if (!exactHit && coverage < 0.45 && semSim < 0.30 && !conceptOverlap) continue;
          if (score < 12) continue;
        }

        const finalScore = (score || 25) * (1 + coverage) + (rec.text ? 20 : 0) + (constraintRes?.valid ? 80 : 0);

        // Extract high-signal snippet around best matching line
        let snippet = '';
        if (rec.text) {
          const lines = rec.text.split('\n');
          const bestLine = lines.find((l) => {
            const ll = l.toLowerCase();
            return codeTokens.some((ct) => ll.includes(ct)) || terms.some((t) => ll.includes(t) || ll.includes(lightStem(t)));
          });
          if (bestLine) {
            const idx = rec.text.indexOf(bestLine);
            const start = Math.max(0, idx - 60);
            snippet = rec.text.slice(start, start + 380).trim();
          } else {
            snippet = rec.text.slice(0, 320).trim();
          }
          snippet = snippet
            .replace(/^\[(?:CSV|TSV|PDF|DOCX|XLSX|PPTX|Body|Metadata|Rows[^\]]*)\]\s*/i, '')
            .replace(/\b(?:Attribute|Field)\s+Value\b/gi, ' ')
            .replace(/(?:^|\s)I(\d[\d,.]*\s*(?:lakhs?|crores?))\b/gi, ' ₹$1')
            .trim();
        }

        rankedFiles.push({
          score: finalScore,
          name: rec.name,
          path: rec.fullPath,
          full_path: rec.fullPath,
          display_path: rec.relPath,
          type: rec.ext.replace(/^\./, '') || 'file',
          open_url: rec.fullPath,
          source: 'local',
          match_type: matched.size && (fnSpaced.includes(terms[0]) || relSpaced.includes(terms[0])) ? 'name' : 'content',
          content_snippet: snippet,
          relPath: rec.relPath,
          rawText: rec.text,
          exactNameHit,
        });
      }
      if (!codeTokens.length && (isAlt || isMulti)) {
        const missingBranches = constraints.branchLabels.filter((_, i) => !matchedBranchSet.has(i));
        if (isAlt) {
          if (!rankedFiles.length) {
            isStrictZeroNumericMatch = true;
            structuredSummary = `No files matching **${constraints.branchLabels.join(' or ')}** were found in your connected folder.`;
          } else if (missingBranches.length) {
            const foundLabels = constraints.branchLabels.filter((_, i) => matchedBranchSet.has(i));
            structuredSummary =
              `Found **${rankedFiles.length}** verified file${rankedFiles.length === 1 ? '' : 's'} for **${foundLabels.join(', ')}**.\n\n` +
              `• No matching **${missingBranches.join(', ')}** files were found in this folder.`;
          }
        } else if (!rankedFiles.length && isMulti) {
          isStrictZeroNumericMatch = true;
          const reqDisp = constraints.branches[0].map((g) => `\`${g.label}\``).join(', ');
          const partialHint = partialGroupSet.size
            ? ` *(Individual matches existed for ${Array.from(partialGroupSet).sort().join(', ')}, but no document satisfied every criterion together.)*`
            : '';
          structuredSummary = `No documents matching **all** criteria (${reqDisp}) were found in your connected folder.${partialHint}`;
        }
      }
    }

    if (codeTokens.length > 0 && !/\b(?:linked|related|referencing|mentioning|other|similar)\b/i.test(qLow)) {
      const fnExact = rankedFiles.filter((f) => f.exactNameHit);
      if (fnExact.length > 0) rankedFiles = fnExact;
    }
    rankedFiles.sort((a, b) => b.score - a.score);

    const totalMatches = rankedFiles.length;
    const pagedFiles = rankedFiles.slice(offset, offset + topFilesLimit).map(({ score: _s, relPath: _r, rawText: _t, exactNameHit: _e, ...rest }) => rest);
    const compactAllFiles = rankedFiles.slice(0, 200).map(({ score: _s, relPath: _r, rawText: _t, exactNameHit: _e, ...rest }) => rest);

    // Build top chunks for LLM context (from overall top ranked hits, up to topChunksLimit)
    for (let i = 0; i < rankedFiles.length && rankedChunks.length < topChunksLimit; i++) {
      const f = rankedFiles[i];
      if (!f.rawText && !f.content_snippet) continue;
      rankedChunks.push({
        chunk_id: `local-${f.relPath}#0`,
        folder_path: rootResolved,
        relative_path: f.relPath,
        filename: f.name,
        citation: f.full_path,
        text: (f.content_snippet || f.rawText || '').slice(0, 1400),
      });
    }

    return {
      folder_path: rootResolved,
      files: pagedFiles,
      chunks: rankedChunks,
      total_matches: totalMatches,
      offset,
      page_size: topFilesLimit,
      has_more: offset + pagedFiles.length < totalMatches,
      all_ranked_files: compactAllFiles,
      structured_summary: structuredSummary || undefined,
      aggregated_entities: aggregatedEntities || undefined,
      folder_stats: folderStats,
      zero_match: !structuredSummary && (isStrictZeroNumericMatch || totalMatches === 0),
      elapsed_ms: Date.now() - t0,
    };
  }
}

module.exports = {
  DesktopSearchEngine,
  extractPdfTextNode,
  extractFileTextNode,
  extractInvoicesFromText,
  extractEntitiesFromDocument,
  parseFlexibleDate,
  evaluateOverdue,
  decodeAscii85,
  parseNumericFilterQuery,
};
