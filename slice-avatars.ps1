Add-Type -AssemblyName System.Drawing

$srcDir = "E:\New folder\stitch_winfinity_futuristic_fitness_platform"
$outDir = "C:\Users\aldwi\WinfinityFitnessTracker\icons\avatars"
$sheets = @("Sheet 1.png", "Sheet 2.png", "Sheet 3.png", "Sheet 4.png")
$cols = 10
$rows = 10
$size = 1024

$total = 0
for ($s = 0; $s -lt $sheets.Count; $s++) {
    $sheetNum = $s + 1
    $path = Join-Path $srcDir $sheets[$s]
    $img = [System.Drawing.Image]::FromFile($path)

    # Distribute 1024px evenly across 10 cells without rounding drift.
    $xBounds = 0..$cols | ForEach-Object { [int][math]::Round(($_ * $size) / $cols) }
    $yBounds = 0..$rows | ForEach-Object { [int][math]::Round(($_ * $size) / $rows) }

    for ($r = 0; $r -lt $rows; $r++) {
        for ($c = 0; $c -lt $cols; $c++) {
            [int]$x = $xBounds[$c]
            [int]$y = $yBounds[$r]
            [int]$w = $xBounds[$c + 1] - $x
            [int]$h = $yBounds[$r + 1] - $y

            $cellIndex = ($r * $cols) + $c + 1
            $cellName = "s{0}-{1:D3}.png" -f $sheetNum, $cellIndex

            $bmp = New-Object System.Drawing.Bitmap($w, $h)
            $g = [System.Drawing.Graphics]::FromImage($bmp)
            $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $srcRect = New-Object System.Drawing.Rectangle($x, $y, $w, $h)
            $destRect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
            $g.DrawImage($img, $destRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
            $g.Dispose()

            $bmp.Save((Join-Path $outDir $cellName), [System.Drawing.Imaging.ImageFormat]::Png)
            $bmp.Dispose()
            $total++
        }
    }
    $img.Dispose()
    Write-Output "Sliced $($sheets[$s]) -> 100 avatars"
}
Write-Output "Total avatars sliced: $total"
