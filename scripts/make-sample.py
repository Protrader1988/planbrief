"""Generates a small fake bid package (RFP page + 3 plan sheets) for testing."""
import sys
from reportlab.lib.pagesizes import letter, landscape
from reportlab.pdfgen import canvas
from reportlab.lib.units import inch

out = sys.argv[1] if len(sys.argv) > 1 else "sample.pdf"
ARCH_D = (36 * inch, 24 * inch)
c = canvas.Canvas(out, pagesize=letter)

# Page 1: RFP cover / instructions
c.setFont("Helvetica-Bold", 22)
c.drawString(1 * inch, 10 * inch, "REQUEST FOR PROPOSAL")
c.setFont("Helvetica", 12)
y = 9.4 * inch
for line in [
    "Project: Harbor Street Lounge Build-Out, 212 Harbor Street, Greenwich, CT",
    "Owner: Harbor Hospitality Group LLC",
    "Architect: Vale Studio Architects",
    "Scope: Interior fit-out of a 3,850 SF ground-floor tenant space into a cocktail lounge,",
    "including new bar, kitchen, two ADA restrooms, finishes, lighting, HVAC and sprinklers.",
    "",
    "Bid due: November 14, 2026 at 2:00 PM EST (sealed, electronic via owner portal)",
    "Pre-bid walkthrough: October 28, 2026 at 10:00 AM (mandatory)",
    "RFIs due: November 4, 2026",
    "Contract: AIA A101 stipulated sum. Liquidated damages $1,500 per calendar day.",
    "Schedule: Notice to proceed Dec 1, 2026. Substantial completion April 15, 2027.",
    "Bonds: 100% performance and payment bonds required.",
    "Insurance: GL $2M/$4M, umbrella $5M, builders risk by owner.",
    "Allowances: $45,000 decorative lighting; $30,000 millwork hardware.",
    "Alternates: Alt 1 polished concrete in lieu of tile. Alt 2 add rooftop condensing unit screen.",
]:
    c.drawString(1 * inch, y, line)
    y -= 0.3 * inch
c.showPage()

# Page 2: site / key plan (landscape)
c.setPageSize(ARCH_D)
W, H = ARCH_D
c.setFont("Helvetica-Bold", 28); c.drawString(1 * inch, H - 1.2 * inch, "A-001  SITE PLAN & GENERAL NOTES")
c.setLineWidth(2); c.rect(3 * inch, 4 * inch, 16 * inch, 12 * inch)
c.setFont("Helvetica", 16); c.drawString(9 * inch, 10 * inch, "212 HARBOR STREET  -  EXISTING 1-STORY BUILDING")
c.rect(8 * inch, 6 * inch, 7 * inch, 5 * inch); c.drawString(9 * inch, 8.4 * inch, "TENANT SPACE  3,850 SF")
c.drawString(3.2 * inch, 3.5 * inch, "HARBOR STREET")
c.setFont("Helvetica-Bold", 16); c.drawString(22 * inch, H - 3 * inch, "GENERAL NOTES")
c.setFont("Helvetica", 13)
notes = [
    "1. Contractor shall verify all existing conditions prior to bid.",
    "2. Work hours 7AM-6PM Mon-Fri; no weekend work without written approval.",
    "3. Deliveries via rear alley only. No street closures.",
    "4. Existing slab to remain; saw-cut as required for plumbing.",
    "5. Occupancy: A-2 assembly, 120 persons. Sprinklered throughout.",
    "6. Asbestos survey by owner; abatement NIC.",
]
yy = H - 3.6 * inch
for n in notes:
    c.drawString(22 * inch, yy, n); yy -= 0.45 * inch
c.showPage()

# Page 3: floor plan
c.setPageSize(ARCH_D)
c.setFont("Helvetica-Bold", 28); c.drawString(1 * inch, H - 1.2 * inch, "A-101  FLOOR PLAN")
c.setLineWidth(3); c.rect(4 * inch, 3 * inch, 24 * inch, 15 * inch)
c.setLineWidth(1.5)
c.rect(5 * inch, 12 * inch, 9 * inch, 5 * inch); c.setFont("Helvetica", 15); c.drawString(8 * inch, 14.5 * inch, "KITCHEN 101  620 SF")
c.rect(15 * inch, 12 * inch, 4 * inch, 5 * inch); c.drawString(15.5 * inch, 14.5 * inch, "RR 102 (ADA)")
c.rect(19.5 * inch, 12 * inch, 4 * inch, 5 * inch); c.drawString(20 * inch, 14.5 * inch, "RR 103 (ADA)")
c.rect(5 * inch, 4 * inch, 18 * inch, 2 * inch); c.drawString(12 * inch, 5 * inch, "BAR 104   42'-0\" LONG")
c.drawString(10 * inch, 9 * inch, "LOUNGE 100   2,100 SF   SEATING 96")
c.setFont("Helvetica", 12); c.drawString(26 * inch, 3.3 * inch, "ENTRY"); c.line(28 * inch, 3 * inch, 28 * inch, 5 * inch)
c.setFont("Helvetica-Bold", 14); c.drawString(30 * inch, 16 * inch, "KEYNOTES")
c.setFont("Helvetica", 12)
for i, k in enumerate(["1  New 2-hr rated demising wall", "2  Walk-in cooler, owner furnished", "3  Grease interceptor below slab", "4  New storefront, see A-401"]):
    c.drawString(30 * inch, 15.4 * inch - i * 0.4 * inch, k)
c.showPage()

# Page 4: finish schedule
c.setPageSize(ARCH_D)
c.setFont("Helvetica-Bold", 28); c.drawString(1 * inch, H - 1.2 * inch, "A-601  FINISH SCHEDULE & DOOR SCHEDULE")
c.setFont("Helvetica-Bold", 14)
hdr = ["ROOM", "FLOOR", "BASE", "WALLS", "CEILING", "REMARKS"]
cols = [2, 7, 11, 14, 19, 24]
for x, h in zip(cols, hdr): c.drawString(x * inch, 19 * inch, h)
c.setFont("Helvetica", 13)
rows = [
    ["100 LOUNGE", "PT-1 PORCELAIN TILE", "WD-1 WALNUT", "PLASTER PL-1 / WOOD PANEL WD-2", "GYP ACT-1 ACOUSTIC", "SEE RCP FOR SOFFITS"],
    ["101 KITCHEN", "QT-1 QUARRY TILE", "QT-1 COVED", "FRP", "WASHABLE ACT-2", "SLOPE TO FLOOR DRAINS"],
    ["102/103 RR", "PT-2 MOSAIC", "PT-2", "CT-1 TILE TO 7'-0\"", "GYP PAINTED", "ADA GRAB BARS"],
    ["104 BAR", "PT-1", "WD-1", "WD-2 PANEL", "GYP", "BAR DIE SEE A-501"],
]
for r, row in enumerate(rows):
    for x, v in zip(cols, row): c.drawString(x * inch, 18.3 * inch - r * 0.5 * inch, v)
c.setFont("Helvetica-Bold", 14); c.drawString(2 * inch, 12 * inch, "DOOR SCHEDULE")
c.setFont("Helvetica", 13)
for r, row in enumerate([["D-1", "3'-0\" x 8'-0\"", "ALUM STOREFRONT", "PANIC HARDWARE"], ["D-2", "3'-0\" x 7'-0\"", "HM 90 MIN", "CLOSER, KICKPLATE"], ["D-3", "3'-0\" x 7'-0\"", "WOOD, 20 MIN", "PRIVACY LOCK"]]):
    for x, v in zip([2, 5, 9, 14], row): c.drawString(x * inch, 11.3 * inch - r * 0.5 * inch, v)
c.save()
print(out)
