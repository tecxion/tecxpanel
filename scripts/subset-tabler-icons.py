#!/usr/bin/env python3
"""Subsetea la fuente Tabler Icons a solo los iconos usados en el frontend.

La fuente completa pesa ~792 KB (~5.800 glifos) y el panel usa ~135. Este script
escanea frontend/ en busca de clases `ti-xxx`, las intersecta con las definidas en
el CSS (mapa clase -> codepoint), añade las construidas dinámicamente (moon/sun del
toggle de tema) y genera un woff2 subset.

Regenerar cuando se añadan iconos nuevos:
    python3 scripts/subset-tabler-icons.py
Luego ajustar el `?v=` del @font-face en tabler-icons.min.css para invalidar caché.

Requiere: pip install fonttools brotli
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend"
CSS = FRONTEND / "vendor" / "tabler" / "tabler-icons.min.css"
FONT_IN = FRONTEND / "vendor" / "tabler" / "fonts" / "tabler-icons.woff2"
FONT_OUT = FRONTEND / "vendor" / "tabler" / "fonts" / "tabler-icons.subset.woff2"

# Iconos construidos dinámicamente (no aparecen como literal `ti-xxx` en el fuente).
DYNAMIC = {"ti-moon", "ti-sun"}

def main():
    css = CSS.read_text(encoding="utf-8")
    # Mapa clase -> codepoint: `.ti-home:before{content:"\eXXX"`
    cp_by_class = {
        "ti-" + name: int(cp, 16)
        for name, cp in re.findall(r"\.ti-([a-z0-9-]+):before\{content:\"\\([0-9a-fA-F]+)\"", css)
    }

    # Todas las clases ti-xxx que aparecen en el frontend (excluyendo vendor/).
    found = set()
    scan = [FRONTEND / "index.html"] + list((FRONTEND / "js").rglob("*.js")) + list((FRONTEND / "views").rglob("*.html"))
    for f in scan:
        for m in re.findall(r"ti-[a-z0-9-]+", f.read_text(encoding="utf-8", errors="ignore")):
            found.add(m)

    used = (found & set(cp_by_class)) | DYNAMIC
    missing = DYNAMIC - set(cp_by_class)
    if missing:
        print(f"AVISO: iconos dinámicos sin codepoint en el CSS: {sorted(missing)}")
    codepoints = sorted({cp_by_class[c] for c in used if c in cp_by_class})

    print(f"Iconos definidos en CSS : {len(cp_by_class)}")
    print(f"Iconos usados (frontend): {len(used)}  -> {len(codepoints)} codepoints")

    from fontTools import subset
    opts = subset.Options()
    opts.flavor = "woff2"
    opts.desubroutinize = True
    # Referenciamos los iconos por codepoint (CSS: content:"\eXXX"), no por
    # ligaduras, así que descartamos GSUB/GPOS: evita el crash de closure en la
    # tabla de ligaduras de Tabler y reduce aún más el tamaño.
    opts.layout_features = []
    opts.ignore_missing_glyphs = True
    opts.notdef_outline = True
    font = subset.load_font(str(FONT_IN), opts)
    subsetter = subset.Subsetter(options=opts)
    subsetter.populate(unicodes=codepoints)
    subsetter.subset(font)
    subset.save_font(font, str(FONT_OUT), opts)

    kb_in = FONT_IN.stat().st_size / 1024
    kb_out = FONT_OUT.stat().st_size / 1024
    print(f"Fuente: {kb_in:.0f} KB -> {kb_out:.0f} KB  ({FONT_OUT.name})")

if __name__ == "__main__":
    sys.exit(main())
