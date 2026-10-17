# Regenerate the bundled, original fictional OCR fixtures on Windows.
Add-Type -AssemblyName System.Drawing
$targetRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\static'))
$lines = Get-Content -LiteralPath (Join-Path $targetRoot 'sample-expected.txt') -Encoding UTF8
foreach ($variant in @('clear', 'difficult')) {
    $bitmap = New-Object System.Drawing.Bitmap 1000,680
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $graphics.Clear([Drawing.Color]::White)
    $graphics.TextRenderingHint = [Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $fontSize = if ($variant -eq 'clear') { 32 } else { 9 }
    $font = New-Object Drawing.Font 'Yu Gothic', $fontSize
    $brush = New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(25,25,25))
    if ($variant -eq 'difficult') {
        $brush.Color = [Drawing.Color]::FromArgb(205,205,205)
        $gradient = New-Object Drawing.Drawing2D.LinearGradientBrush ([Drawing.Point]::new(0,0)),([Drawing.Point]::new(1000,680)),([Drawing.Color]::White),([Drawing.Color]::FromArgb(175,175,175))
        $graphics.FillRectangle($gradient,0,0,1000,680)
        $gradient.Dispose()
    }
    for ($i=0; $i -lt $lines.Count; $i++) {
        $graphics.DrawString($lines[$i],$font,$brush,60,(60 + $i * 88))
    }
    $bitmap.Save((Join-Path $targetRoot "sample-$variant.png"),[Drawing.Imaging.ImageFormat]::Png)
    $brush.Dispose()
    $font.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
}
