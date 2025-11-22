#!/usr/bin/env python3
"""Create blue dove icons for Chrome extension"""

try:
    from PIL import Image, ImageDraw
    print("✓ PIL/Pillow is installed")
except ImportError:
    print("✗ PIL/Pillow not installed. Installing...")
    import subprocess
    subprocess.check_call(['pip3', 'install', 'pillow'])
    from PIL import Image, ImageDraw

def create_dove_icon(size):
    """Create a blue dove icon"""
    # Create image with transparency
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Blue gradient colors
    blue_bg = (74, 144, 226)  # #4A90E2

    # Draw rounded rectangle background
    padding = size // 16
    corner = size // 5

    # Background with rounded corners
    draw.rounded_rectangle(
        [padding, padding, size - padding, size - padding],
        radius=corner,
        fill=blue_bg
    )

    # Scale factor
    s = size / 128.0

    # Center coordinates
    cx, cy = size // 2, size // 2

    # Dove body (white ellipse)
    body_w = int(18 * s)
    body_h = int(22 * s)
    draw.ellipse(
        [cx - body_w, cy - body_h//2 + int(5*s),
         cx + body_w, cy + body_h//2 + int(5*s)],
        fill=(255, 255, 255, 240)
    )

    # Dove head (white circle)
    head_r = int(12 * s)
    draw.ellipse(
        [cx - head_r, cy - head_r - int(12*s),
         cx + head_r, cy + head_r - int(12*s)],
        fill=(255, 255, 255, 240)
    )

    # Left wing (polygon)
    left_wing = [
        (cx - int(8*s), cy - int(5*s)),
        (cx - int(35*s), cy - int(15*s)),
        (cx - int(15*s), cy - int(8*s))
    ]
    draw.polygon(left_wing, fill=(255, 255, 255, 230))

    # Right wing (polygon)
    right_wing = [
        (cx + int(8*s), cy - int(5*s)),
        (cx + int(35*s), cy - int(15*s)),
        (cx + int(15*s), cy - int(8*s))
    ]
    draw.polygon(right_wing, fill=(255, 255, 255, 220))

    # Tail (small triangle)
    tail = [
        (cx - int(6*s), cy + int(22*s)),
        (cx, cy + int(28*s)),
        (cx + int(6*s), cy + int(22*s))
    ]
    draw.polygon(tail, fill=(255, 255, 255, 230))

    # Eye (small dark blue circle)
    eye_r = max(int(2*s), 1)
    draw.ellipse(
        [cx - int(3*s) - eye_r, cy - int(14*s) - eye_r,
         cx - int(3*s) + eye_r, cy - int(14*s) + eye_r],
        fill=(74, 144, 226, 255)
    )

    # Beak (small orange triangle)
    beak = [
        (cx + int(2*s), cy - int(16*s)),
        (cx + int(8*s), cy - int(14*s)),
        (cx + int(2*s), cy - int(12*s))
    ]
    draw.polygon(beak, fill=(255, 183, 77, 230))

    return img

# Create icons
print("Creating blue dove icons...")
for size in [16, 48, 128]:
    icon = create_dove_icon(size)
    filename = f'icon-{size}.png'
    icon.save(filename, 'PNG')
    print(f'✓ Created {filename} ({size}x{size})')

print("\n✅ All blue dove icons created successfully!")
print("📁 Files saved in:", __file__.rsplit('/', 1)[0] if '/' in __file__ else '.')
