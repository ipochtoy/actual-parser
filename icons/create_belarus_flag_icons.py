#!/usr/bin/env python3
"""Create Belarus white-red-white flag icons for Chrome extension"""

from PIL import Image, ImageDraw

def create_belarus_flag_icon(size):
    """Create a Belarus flag icon with white-red-white horizontal stripes"""
    # Create image with transparency
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Colors
    white = (255, 255, 255, 255)
    red = (200, 49, 62, 255)  # #C8313E

    # Rounded square background padding
    padding = size // 16
    corner_radius = size // 5

    # Calculate stripe heights (1:1:1 proportions)
    inner_size = size - (2 * padding)
    stripe_height = inner_size // 3

    # Top position
    top_y = padding

    # Draw rounded rectangle container
    draw.rounded_rectangle(
        [padding, padding, size - padding, size - padding],
        radius=corner_radius,
        fill=white  # Will be overwritten by stripes
    )

    # Draw the three horizontal stripes inside rounded rectangle
    # We need to clip to the rounded rectangle, so we'll draw stripes on a separate layer

    # Create a mask for the rounded rectangle
    mask = Image.new('L', (size, size), 0)
    mask_draw = ImageDraw.Draw(mask)
    mask_draw.rounded_rectangle(
        [padding, padding, size - padding, size - padding],
        radius=corner_radius,
        fill=255
    )

    # Create stripe layer
    stripes = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    stripes_draw = ImageDraw.Draw(stripes)

    # Top white stripe
    stripes_draw.rectangle(
        [padding, padding, size - padding, padding + stripe_height],
        fill=white
    )

    # Middle red stripe
    stripes_draw.rectangle(
        [padding, padding + stripe_height, size - padding, padding + 2 * stripe_height],
        fill=red
    )

    # Bottom white stripe
    stripes_draw.rectangle(
        [padding, padding + 2 * stripe_height, size - padding, size - padding],
        fill=white
    )

    # Composite the stripes with the rounded mask
    img = Image.composite(stripes, img, mask)

    # Optional: Add subtle border
    border_color = (220, 220, 220, 255)
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle(
        [padding, padding, size - padding - 1, size - padding - 1],
        radius=corner_radius,
        outline=border_color,
        width=1
    )

    return img

# Create icons
print("Creating Belarus white-red-white flag icons...")
for size in [16, 48, 128]:
    icon = create_belarus_flag_icon(size)
    filename = f'icon-{size}.png'
    icon.save(filename, 'PNG')
    print(f'✓ Created {filename} ({size}x{size})')

print("\n✅ All Belarus flag icons created successfully!")
print("🏳️  White-Red-White horizontal stripes (1:1:1)")
print("📁 Files saved in:", __file__.rsplit('/', 1)[0] if '/' in __file__ else '.')
