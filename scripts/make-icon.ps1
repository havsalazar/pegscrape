# Pegscrape app icon: an artificial horizon tilted 40 degrees (a bike leaning into a corner) with
# the bike upright on it. "Night teal" colours. Run from the project root:
#   powershell -File scripts/make-icon.ps1
# Writes build/icon.png, the Tauri icons made from it (src-tauri/icons), and, once
# `npm run android:init` has created src-tauri/gen/android, the Android launcher icons.
param([string]$Root = (Split-Path $PSScriptRoot -Parent))
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'

$Colors = @{
  BgTop = '#1e293b'; BgBottom = '#0f172a'      # tile
  Sky = '#334155'; Ground = '#14b8a6'          # horizon halves
  Line = '#f8fafc'; Ring = '#f8fafc'           # horizon line and ring
  BikeFill = '#f8fafc'; BikeOutline = '#0f172a'
}
# Android adaptive icon background (a solid colour; the middle of the tile's gradient).
$AndroidBackground = '#172033'
$BikeImage = Join-Path $Root 'resourece\bike-back-view.png'

function Hex([string]$hex) { [System.Drawing.ColorTranslator]::FromHtml($hex) }

function Tile-Path($size, $inset, $radius) {
  $m = $size * $inset; $w = $size - 2 * $m; $r = $size * $radius
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $p.AddArc([single]$m, [single]$m, [single](2 * $r), [single](2 * $r), 180, 90)
  $p.AddArc([single]($m + $w - 2 * $r), [single]$m, [single](2 * $r), [single](2 * $r), 270, 90)
  $p.AddArc([single]($m + $w - 2 * $r), [single]($m + $w - 2 * $r), [single](2 * $r), [single](2 * $r), 0, 90)
  $p.AddArc([single]$m, [single]($m + $w - 2 * $r), [single](2 * $r), [single](2 * $r), 90, 90)
  $p.CloseFigure(); return $p
}

function Draw-BikeImage($g, $img, $color, $x, $y, $w, $h) {
  $cm = New-Object System.Drawing.Imaging.ColorMatrix
  $cm.Matrix00 = 0; $cm.Matrix11 = 0; $cm.Matrix22 = 0
  $cm.Matrix40 = $color.R / 255; $cm.Matrix41 = $color.G / 255; $cm.Matrix42 = $color.B / 255; $cm.Matrix33 = 1
  $ia = New-Object System.Drawing.Imaging.ImageAttributes; $ia.SetColorMatrix($cm)
  $rect = New-Object System.Drawing.RectangleF ([single]$x), ([single]$y), ([single]$w), ([single]$h)
  $g.DrawImage($img, [System.Drawing.Rectangle]::Round($rect), 0, 0, $img.Width, $img.Height, 'Pixel', $ia)
}

<#
  Mode: 'tile' = rounded square (Windows, legacy Android), 'round' = circle (legacy round),
        'foreground' = artwork only on transparent, sized for the adaptive icon safe zone.
#>
function Render([int]$size, [string]$mode, [string]$out) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'; $g.InterpolationMode = 'HighQualityBicubic'; $g.PixelOffsetMode = 'HighQuality'
  $g.Clear([System.Drawing.Color]::Transparent)

  $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush (New-Object System.Drawing.PointF 0, 0), (New-Object System.Drawing.PointF 0, $size), (Hex $Colors.BgTop), (Hex $Colors.BgBottom)
  # k scales the artwork around the centre: 1 fills the tile like the Windows icon.
  switch ($mode) {
    'tile' { $g.FillPath($bg, (Tile-Path $size 0.04 0.22)); $k = 1.0 }
    'round' { $g.FillEllipse($bg, 0, 0, $size, $size); $k = 1.1 }
    'foreground' { $k = 0.8 }
  }

  $c = $size / 2; $r = $size * 0.36 * $k
  $circle = New-Object System.Drawing.Drawing2D.GraphicsPath
  $circle.AddEllipse([single]($c - $r), [single]($c - $r), [single](2 * $r), [single](2 * $r))
  $g.SetClip($circle)
  $g.TranslateTransform([single]$c, [single]$c); $g.RotateTransform(-40)
  $g.FillRectangle((New-Object System.Drawing.SolidBrush (Hex $Colors.Sky)), [single](-$size), [single](-$size), [single](2 * $size), [single]$size)
  $g.FillRectangle((New-Object System.Drawing.SolidBrush (Hex $Colors.Ground)), [single](-$size), 0, [single](2 * $size), [single]$size)
  $g.DrawLine((New-Object System.Drawing.Pen (Hex $Colors.Line), ([single]($size * 0.02 * $k))), [single](-$size), 0, [single]$size, 0)
  $g.ResetTransform(); $g.ResetClip()
  $g.DrawEllipse((New-Object System.Drawing.Pen (Hex $Colors.Ring), ([single]($size * 0.03 * $k))), [single]($c - $r), [single]($c - $r), [single](2 * $r), [single](2 * $r))

  # The bike, upright, with a dark outline so it reads on both halves.
  $img = [System.Drawing.Image]::FromFile($BikeImage)
  $bh = $size * 0.5 * $k; $bw = $bh * $img.Width / $img.Height
  $x = $c - $bw / 2; $y = $c + $size * 0.3 * $k - $bh
  $o = $size * 0.012 * $k
  foreach ($a in 0..15) {
    $t = $a * [Math]::PI / 8
    Draw-BikeImage $g $img (Hex $Colors.BikeOutline) ($x + $o * [Math]::Cos($t)) ($y + $o * [Math]::Sin($t)) $bw $bh
  }
  Draw-BikeImage $g $img (Hex $Colors.BikeFill) $x $y $bw $bh
  $img.Dispose()

  $g.Dispose()
  New-Item -ItemType Directory -Force (Split-Path $out) | Out-Null
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
}

# Windows: the source icon; `tauri icon` makes the .ico/.png set in src-tauri/icons from it.
Render 1024 'tile' (Join-Path $Root 'build\icon.png')
Push-Location $Root
try { npx tauri icon build/icon.png; if ($LASTEXITCODE) { throw 'tauri icon failed' } } finally { Pop-Location }

# Android launcher icons: legacy (48dp) and adaptive foreground (108dp) per density. These replace
# the ones `tauri icon` wrote, because the adaptive foreground needs the art inside the safe zone.
$res = Join-Path $Root 'src-tauri\gen\android\app\src\main\res'
if (-not (Test-Path $res)) { Write-Host 'No src-tauri/gen/android yet: skipping the Android icons.'; return }
foreach ($d in @(@('mdpi', 1), @('hdpi', 1.5), @('xhdpi', 2), @('xxhdpi', 3), @('xxxhdpi', 4))) {
  $dir = Join-Path $res "mipmap-$($d[0])"
  Render ([int](48 * $d[1])) 'tile' (Join-Path $dir 'ic_launcher.png')
  Render ([int](48 * $d[1])) 'round' (Join-Path $dir 'ic_launcher_round.png')
  Render ([int](108 * $d[1])) 'foreground' (Join-Path $dir 'ic_launcher_foreground.png')
}
Set-Content -Encoding utf8 (Join-Path $res 'values\ic_launcher_background.xml') @"
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">$AndroidBackground</color>
</resources>
"@
