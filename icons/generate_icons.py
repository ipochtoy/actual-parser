#!/usr/bin/env python3
from PIL import Image, ImageDraw
import math

def create_icon(size):
    # Create image with transparent background
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Calculate dimensions
    padding = size // 8
    corner_radius = size // 5

    # Draw rounded rectangle background with gradient effect
    # Purple-blue gradient simulation with layered rectangles
    colors = [
        (102, 126, 234, 255),  # #667eea
        (108, 118, 227, 255),
        (114, 110, 220, 255),
        (118, 95, 195, 255),
        (118, 75, 162, 255),   # #764ba2
    ]

    for i, color in enumerate(colors):
        offset = i * 2
        draw.rounded_rectangle(
            [padding + offset, padding + offset, size - padding - offset, size - padding - offset],
            radius=corner_radius,
            fill=color
        )

    # Draw package/box icon in white
    center_x = size // 2
    center_y = size // 2
    box_size = size // 3

    # Box coordinates
    top_x = center_x
    top_y = center_y - box_size // 2
    left_x = center_x - box_size // 2
    left_y = center_y
    right_x = center_x + box_size // 2
    right_y = center_y
    bottom_x = center_x
    bottom_y = center_y + box_size // 2

    # Draw box faces
    # Back face (lighter)
    draw.polygon([
        (top_x, top_y),
        (right_x, right_y),
        (bottom_x, bottom_y),
        (center_x, center_y + box_size // 4)
    ], fill=(255, 255, 255, 220))

    # Left face (medium)
    draw.polygon([
        (top_x, top_y),
        (left_x, left_y),
        (bottom_x, bottom_y),
        (center_x, center_y + box_size // 4)
    ], fill=(255, 255, 255, 180))

    # Front face (brightest)
    draw.polygon([
        (top_x, top_y),
        (left_x, left_y),
        (right_x, right_y),
        (center_x, center_y + box_size // 4)
    ], fill=(255, 255, 255, 240))

    # Draw center line
    line_width = max(2, size // 50)
    draw.line([
        (center_x, top_y),
        (center_x, center_y + box_size // 4)
    ], fill=(102, 126, 234, 255), width=line_width)

    return img

# Generate icons in different sizes
sizes = [16, 48, 128]
for size in sizes:
    icon = create_icon(size)
    icon.save(f'icon-{size}.png', 'PNG')
    print(f'Created icon-{size}.png')

print('All icons generated successfully!')
