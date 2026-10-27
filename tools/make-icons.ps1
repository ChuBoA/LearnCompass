# 產生 APP 圖示（羅盤）：powershell -ExecutionPolicy Bypass -File tools\make-icons.ps1
param([string]$OutDir = (Join-Path $PSScriptRoot '..\icons'))
Add-Type -AssemblyName System.Drawing

function Color([string]$hex, [int]$alpha = 255) {
  $c = [System.Drawing.ColorTranslator]::FromHtml($hex)
  [System.Drawing.Color]::FromArgb($alpha, $c.R, $c.G, $c.B)
}

function New-Icon([int]$size, [string]$path, [bool]$rounded, [double]$scale) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)
  $rect = New-Object System.Drawing.Rectangle 0, 0, $size, $size
  $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, (Color '#ffb37a'), (Color '#e8684f'), 45
  if ($rounded) {
    $r = [int]($size * 0.22)
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $p.AddArc(0, 0, 2 * $r, 2 * $r, 180, 90); $p.AddArc($size - 2 * $r, 0, 2 * $r, 2 * $r, 270, 90)
    $p.AddArc($size - 2 * $r, $size - 2 * $r, 2 * $r, 2 * $r, 0, 90); $p.AddArc(0, $size - 2 * $r, 2 * $r, 2 * $r, 90, 90)
    $p.CloseFigure(); $g.FillPath($bg, $p)
  } else { $g.FillRectangle($bg, $rect) }

  $c = $size / 2.0; $u = $size / 512.0 * $scale
  $cream = Color '#fff8ef' 235
  $ink = Color '#2b2622'

  # 外圈與四個刻度
  $ringPen = New-Object System.Drawing.Pen $cream, ([single](28 * $u))
  $g.DrawEllipse($ringPen, [single]($c - 168 * $u), [single]($c - 168 * $u), [single](336 * $u), [single](336 * $u))
  $tick = New-Object System.Drawing.Pen $cream, ([single](24 * $u))
  $tick.StartCap = 'Round'; $tick.EndCap = 'Round'
  foreach ($a in 0, 90, 180, 270) {
    $rad = $a * [Math]::PI / 180
    $g.DrawLine($tick, [single]($c + 184 * $u * [Math]::Sin($rad)), [single]($c - 184 * $u * [Math]::Cos($rad)), [single]($c + 144 * $u * [Math]::Sin($rad)), [single]($c - 144 * $u * [Math]::Cos($rad)))
  }

  # 指針：北（奶油色）與南（深色半透明）
  $north = [System.Drawing.PointF[]]@(
    (New-Object System.Drawing.PointF ([single]$c), ([single]($c - 128 * $u))),
    (New-Object System.Drawing.PointF ([single]($c + 48 * $u)), ([single]$c)),
    (New-Object System.Drawing.PointF ([single]($c - 48 * $u)), ([single]$c)))
  $south = [System.Drawing.PointF[]]@(
    (New-Object System.Drawing.PointF ([single]$c), ([single]($c + 128 * $u))),
    (New-Object System.Drawing.PointF ([single]($c - 48 * $u)), ([single]$c)),
    (New-Object System.Drawing.PointF ([single]($c + 48 * $u)), ([single]$c)))
  $g.FillPolygon((New-Object System.Drawing.SolidBrush (Color '#fff8ef')), $north)
  $g.FillPolygon((New-Object System.Drawing.SolidBrush (Color '#2b2622' 140)), $south)
  $g.FillEllipse((New-Object System.Drawing.SolidBrush $ink), [single]($c - 28 * $u), [single]($c - 28 * $u), [single](56 * $u), [single](56 * $u))

  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}

New-Icon 192 (Join-Path $OutDir 'icon-192.png') $true 1.0
New-Icon 512 (Join-Path $OutDir 'icon-512.png') $true 1.0
New-Icon 512 (Join-Path $OutDir 'icon-maskable-512.png') $false 0.78
New-Icon 180 (Join-Path $OutDir 'apple-touch-icon.png') $false 0.9
