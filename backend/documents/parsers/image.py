"""Image Document Parser with offline neural OCR text extraction."""
from __future__ import annotations

from datetime import datetime
from pathlib import Path

from ..models import Document
from ..ocr import IMAGE_EXTENSIONS, extract_text_from_image_bytes
from ..parser import DocumentParser
from .common import metadata_for, source_for


class ImageParser(DocumentParser):
    """Parses raster image files (PNG, JPG, WEBP, BMP, TIFF, GIF) using OCR."""

    extensions = IMAGE_EXTENSIONS

    def parse_bytes(
        self,
        *,
        filename: str,
        relative_path: str,
        data: bytes,
        modified_at: datetime | None = None,
    ) -> Document:
        ext = Path(filename).suffix.casefold().lstrip(".") or "png"
        ocr_text, ocr_meta = extract_text_from_image_bytes(
            data,
            filename=filename,
            allow_small=True,
            strict=True,
        )
        body = f"[Image OCR]\n{ocr_text}" if ocr_text else ""
        locations = [f"Page {i}" for i in range(1, max(1, int(ocr_meta.get("frames", 1))) + 1)]
        if int(ocr_meta.get("frames", 1)) <= 1:
            locations = ["Image"]
        meta = metadata_for(len(data), modified_at, extra=ocr_meta)
        return Document(
            source=source_for(filename, relative_path, ext),
            metadata=meta,
            text=body,
            tables=[],
            locations=locations,
        )

