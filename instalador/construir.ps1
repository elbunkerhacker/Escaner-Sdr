# Genera el instalable de Windows: dist\EscanerSDR-Setup-<versión>.exe
#
#   powershell -ExecutionPolicy Bypass -File instalador\construir.ps1
#
# Necesita Inno Setup 6 (winget install JRSoftware.InnoSetup). Descarga y verifica Node.js portátil,
# rtl_tcp x64 de RTL-SDR Blog y Zadig, los junta con la app en build\app y compila escaner-sdr.iss.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Raiz = Split-Path $PSScriptRoot
$Build = Join-Path $Raiz 'build'
$Cache = Join-Path $Build 'descargas'
$Stage = Join-Path $Build 'app'
$Dist = Join-Path $Raiz 'dist'
$Version = (Get-Content (Join-Path $Raiz 'package.json') -Raw | ConvertFrom-Json).version

# Versiones fijadas de los componentes
$NodeVer = 'v24.22.3'
$RtlUrl = 'https://github.com/rtlsdrblog/rtl-sdr-blog/releases/download/V1.4.0/Release.zip'
# Hash fijado (RTL-SDR Blog no publica sumas): coincide con los binarios usados para probar el escáner
$RtlSha256Fijado = '7EF33F1304647F65E5E0FDE43637A73D54F076E91E651A3CECC4F55A17FD9815'
$ZadigUrl = 'https://github.com/pbatard/libwdi/releases/download/v1.5.1/zadig-2.9.exe'

function Write-Paso($t) { Write-Host "`n== $t" -ForegroundColor Cyan }

function Get-Descarga($url, $nombre) {
  $f = Join-Path $Cache $nombre
  if (-not (Test-Path $f)) {
    Write-Host "  descargando $url"
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile "$f.part"
    Move-Item "$f.part" $f -Force
  } else { Write-Host "  en caché: $nombre" }
  $f
}

function Assert-Sha256($archivo, $esperado) {
  $h = (Get-FileHash $archivo -Algorithm SHA256).Hash
  if ($h -ne $esperado.ToUpper()) { Remove-Item $archivo -Force; throw "SHA-256 incorrecto en $(Split-Path $archivo -Leaf): $h (esperado $esperado)" }
  Write-Host "  SHA-256 correcto"
}

function Expand-Limpio($zip, $destino) {
  if (Test-Path $destino) { Remove-Item $destino -Recurse -Force }
  Expand-Archive $zip $destino -Force
}

# ---------------------------------------------------------------- Inno Setup
$Iscc = Get-ChildItem "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe", "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $Iscc) { throw 'No encuentro Inno Setup 6. Instálalo con: winget install JRSoftware.InnoSetup' }

New-Item -ItemType Directory -Force $Cache, $Dist | Out-Null
if (Test-Path $Stage) { Remove-Item $Stage -Recurse -Force }
New-Item -ItemType Directory -Force $Stage | Out-Null

# ---------------------------------------------------------------- Node.js portátil
Write-Paso "Node.js $NodeVer"
$nodeZip = Get-Descarga "https://nodejs.org/dist/$NodeVer/node-$NodeVer-win-x64.zip" "node-$NodeVer-win-x64.zip"
$sums = (Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/$NodeVer/SHASUMS256.txt").Content
if ($sums -is [byte[]]) { $sums = [Text.Encoding]::ASCII.GetString($sums) }
$linea = ($sums -split "`n") | Where-Object { $_ -match "\snode-$NodeVer-win-x64\.zip\s*$" } | Select-Object -First 1
if (-not $linea) { throw 'No encuentro el hash de Node.js en SHASUMS256.txt' }
Assert-Sha256 $nodeZip (($linea.Trim() -split '\s+')[0])
$nodeDir = Join-Path $Build "extraido\node"
Expand-Limpio $nodeZip $nodeDir
$nodeRoot = Join-Path $nodeDir "node-$NodeVer-win-x64"
New-Item -ItemType Directory -Force (Join-Path $Stage 'runtime') | Out-Null
Copy-Item (Join-Path $nodeRoot 'node.exe'), (Join-Path $nodeRoot 'LICENSE') (Join-Path $Stage 'runtime')

# ---------------------------------------------------------------- rtl_tcp x64
Write-Paso 'rtl_tcp x64 (RTL-SDR Blog V1.4.0)'
$rtlZip = Get-Descarga $RtlUrl 'rtl-sdr-blog-V1.4.0-Release.zip'
Assert-Sha256 $rtlZip $RtlSha256Fijado
$rtlDir = Join-Path $Build 'extraido\rtl-sdr'
Expand-Limpio $rtlZip $rtlDir
$rtlDest = Join-Path $Stage 'tools\rtl-sdr-x64'
New-Item -ItemType Directory -Force $rtlDest | Out-Null
Copy-Item (Join-Path $rtlDir 'x64\*.exe'), (Join-Path $rtlDir 'x64\*.dll') $rtlDest

# ---------------------------------------------------------------- Zadig
Write-Paso 'Zadig 2.9'
$zadig = Get-Descarga $ZadigUrl 'zadig-2.9.exe'
$firma = Get-AuthenticodeSignature $zadig
if ($firma.Status -ne 'Valid' -or $firma.SignerCertificate.Subject -notmatch 'Akeo') {
  Remove-Item $zadig -Force
  throw "La firma de Zadig no es válida ($($firma.Status), $($firma.SignerCertificate.Subject))"
}
Write-Host "  firma válida: $($firma.SignerCertificate.Subject)"
New-Item -ItemType Directory -Force (Join-Path $Stage 'drivers') | Out-Null
Copy-Item $zadig (Join-Path $Stage 'drivers\zadig.exe')

# ---------------------------------------------------------------- la app
Write-Paso 'Archivos de la app'
foreach ($f in 'server.js', 'dsp.js', 'sim-rtl-tcp.js', 'package.json', 'bandeja.ps1', 'README.md') {
  Copy-Item (Join-Path $Raiz $f) $Stage
}
Copy-Item (Join-Path $Raiz 'public') $Stage -Recurse
if (-not (Test-Path (Join-Path $Raiz 'node_modules\ws'))) { throw 'Falta node_modules\ws: ejecuta antes npm.cmd install' }
New-Item -ItemType Directory -Force (Join-Path $Stage 'node_modules') | Out-Null
Copy-Item (Join-Path $Raiz 'node_modules\ws') (Join-Path $Stage 'node_modules') -Recurse
Copy-Item (Join-Path $PSScriptRoot 'comprobar-driver.ps1'), (Join-Path $PSScriptRoot 'LICENCIAS-TERCEROS.txt') $Stage

# ---------------------------------------------------------------- icono (.ico con varios tamaños)
Write-Paso 'Icono'
Add-Type -AssemblyName System.Drawing
function New-Png([int]$s) {
  $bmp = New-Object System.Drawing.Bitmap $s, $s
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)
  $k = $s / 32.0
  $r = [Math]::Max(2, [int](6 * $k))
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $w = $s - 1
  $path.AddArc(0, 0, 2 * $r, 2 * $r, 180, 90); $path.AddArc($w - 2 * $r, 0, 2 * $r, 2 * $r, 270, 90)
  $path.AddArc($w - 2 * $r, $w - 2 * $r, 2 * $r, 2 * $r, 0, 90); $path.AddArc(0, $w - 2 * $r, 2 * $r, 2 * $r, 90, 90)
  $path.CloseFigure()
  $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 11, 18, 32))), $path)
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 34, 211, 238)), ([Math]::Max(1.5, 2.6 * $k))
  $pen.LineJoin = 'Round'; $pen.StartCap = 'Round'; $pen.EndCap = 'Round'
  $xy = @(3, 24, 8, 22, 11, 10, 14, 21, 17, 16, 20, 22, 23, 5, 26, 22, 29, 24)
  $pts = for ($i = 0; $i -lt $xy.Count; $i += 2) { New-Object System.Drawing.PointF ([float]($xy[$i] * $k)), ([float]($xy[$i + 1] * $k)) }
  $g.DrawLines($pen, [System.Drawing.PointF[]]$pts)
  $g.Dispose()
  $ms = New-Object IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  , $ms.ToArray()
}
$tamanos = 16, 24, 32, 48, 64, 128, 256
$imgs = foreach ($t in $tamanos) { , (New-Png $t) }
$ico = New-Object IO.MemoryStream
$bw = New-Object IO.BinaryWriter $ico
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$tamanos.Count)
$offset = 6 + 16 * $tamanos.Count
for ($i = 0; $i -lt $tamanos.Count; $i++) {
  $t = $tamanos[$i]; $d = $imgs[$i]
  $bw.Write([byte]($t % 256)); $bw.Write([byte]($t % 256)); $bw.Write([byte]0); $bw.Write([byte]0)
  $bw.Write([uint16]1); $bw.Write([uint16]32); $bw.Write([uint32]$d.Length); $bw.Write([uint32]$offset)
  $offset += $d.Length
}
foreach ($d in $imgs) { $bw.Write([byte[]]$d) }
$bw.Flush()
[IO.File]::WriteAllBytes((Join-Path $Stage 'escaner.ico'), $ico.ToArray())

# ---------------------------------------------------------------- compilar
Write-Paso "Compilando el instalador $Version"
& $Iscc.FullName "/DAppVersion=$Version" "/DStage=$Stage" "/DDist=$Dist" (Join-Path $PSScriptRoot 'escaner-sdr.iss')
if ($LASTEXITCODE -ne 0) { throw "ISCC terminó con código $LASTEXITCODE" }
$exe = Join-Path $Dist "EscanerSDR-Setup-$Version.exe"
Write-Host "`nInstalador listo: $exe ($([Math]::Round((Get-Item $exe).Length / 1MB, 1)) MB)" -ForegroundColor Green
