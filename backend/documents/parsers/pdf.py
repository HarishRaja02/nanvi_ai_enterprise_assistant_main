from datetime import datetime
from io import BytesIO
from ..parser import DocumentParser
from ..models import Document
from ..ocr import iter_pdf_pages_with_ocr
from .common import source_for, metadata_for


class PDFParser(DocumentParser):
    extensions = frozenset({".pdf"})

    def parse_bytes(
        self,
        *,
        filename: str,
        relative_path: str,
        data: bytes,
        modified_at: datetime | None = None,
    ) -> Document:
        try:
            from pypdf import PdfReader
            reader = PdfReader(BytesIO(data))
            metadata = reader.metadata or {}
        except Exception as exc:
            raise ValueError("Malformed PDF document") from exc

        chunks, locations = [], []
        try:
            for page_num, page_text, _used_ocr in iter_pdf_pages_with_ocr(data):
                if page_text:
                    chunks.append(f"[Page {page_num}]\n{page_text}")
                    locations.append(f"Page {page_num}")
        except Exception as exc:
            raise ValueError("Malformed PDF document") from exc

        return Document(
            source_for(filename, relative_path, "pdf"),
            metadata_for(len(data), modified_at, pdf_metadata={k: str(v) for k, v in metadata.items()}),
            "\n\n".join(chunks),
            [],
            locations,
        )
