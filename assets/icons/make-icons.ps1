# Generates the app icons for חיים משותפים.
#
# Two interlocking rings in the app's coral and lavender: one life, another
# life, a shared middle. Drawn full-bleed rather than as a small badge inside a
# margin, because Android masks icons to a circle and crops anything inset.
# All artwork sits inside the central 80% safe zone so the mask never clips it.
#
#   pwsh -File make-icons.ps1

Add-Type -AssemblyName System.Drawing

$OutDir = $PSScriptRoot
$Size   = 512

$bgFrom   = [System.Drawing.Color]::FromArgb(255, 255, 244, 239)  # warm cream
$bgTo     = [System.Drawing.Color]::FromArgb(255, 255, 226, 214)  # soft peach
$coral    = [System.Drawing.Color]::FromArgb(255, 232, 131, 124)  # --accent-primary
$lavender = [System.Drawing.Color]::FromArgb(255, 155, 142, 196)  # --accent-secondary

$bmp = New-Object System.Drawing.Bitmap($Size, $Size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

# Full-bleed background
$rect = New-Object System.Drawing.Rectangle(0, 0, $Size, $Size)
$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $bgFrom, $bgTo, 45.0)
$g.FillRectangle($brush, $rect)
$brush.Dispose()

# Ring geometry. Centres 100px apart, equal radii, so they overlap by a third.
$radius = 100
$stroke = 40
$cy = 256
$c1x = 206
$c2x = 306

function New-RingPen($colour) {
  $pen = New-Object System.Drawing.Pen($colour, $stroke)
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round
  return $pen
}

$penCoral    = New-RingPen $coral
$penLavender = New-RingPen $lavender

$r1 = New-Object System.Drawing.Rectangle(($c1x - $radius), ($cy - $radius), ($radius * 2), ($radius * 2))
$r2 = New-Object System.Drawing.Rectangle(($c2x - $radius), ($cy - $radius), ($radius * 2), ($radius * 2))

$g.DrawEllipse($penCoral, $r1)
$g.DrawEllipse($penLavender, $r2)

# Weave: the circles meet at (256, 256±87). Redrawing a short arc of the coral
# ring over the upper crossing makes them read as interlocked rather than as
# two rings that merely overlap.
$g.DrawArc($penCoral, $r1, -80, 40)

$penCoral.Dispose()
$penLavender.Dispose()
$g.Dispose()

# Save at each size, downscaling from the 512 master.
foreach ($target in 512, 192) {
  $out = New-Object System.Drawing.Bitmap($target, $target)
  $og = [System.Drawing.Graphics]::FromImage($out)
  $og.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $og.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $og.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $og.DrawImage($bmp, (New-Object System.Drawing.Rectangle(0, 0, $target, $target)))
  $og.Dispose()

  $path = Join-Path $OutDir "icon-$target.png"
  $out.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $out.Dispose()
  "{0}  {1}x{1}  {2} KB" -f (Split-Path $path -Leaf), $target, [int]((Get-Item $path).Length / 1KB)
}

$bmp.Dispose()
