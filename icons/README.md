# Icons

Use the `icon.svg` file to generate PNG icons in the following sizes:

- icon-16.png (16x16)
- icon-48.png (48x48)
- icon-128.png (128x128)

## Generate PNGs from SVG

### Option 1: Online Tool
1. Open https://cloudconvert.com/svg-to-png
2. Upload icon.svg
3. Convert to each size (16px, 48px, 128px)

### Option 2: Using ImageMagick
```bash
convert icon.svg -resize 16x16 icon-16.png
convert icon.svg -resize 48x48 icon-48.png
convert icon.svg -resize 128x128 icon-128.png
```

### Option 3: Using Python with Pillow
```bash
pip install Pillow
python3 generate_icons.py
```

## Design
- Blue/purple gradient (#667eea to #764ba2)
- Rounded square background
- Modern package/box icon in white
- Clean, professional look
