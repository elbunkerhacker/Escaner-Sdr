# Escáner SDR de el Búnker Hacker — icono en la bandeja del sistema (Windows)
#
# Arranca y detiene rtl_tcp y el servidor web sin ventanas, y libera el RTL-SDR
# para poder usarlo con otros programas (SDR#, etc.).
#
#   Con icono:      «Escaner SDR.cmd»  (o: powershell -ExecutionPolicy Bypass -File bandeja.ps1)
#   Sin icono:      powershell -ExecutionPolicy Bypass -File bandeja.ps1 -Accion iniciar|detener|estado

param(
  [ValidateSet('', 'iniciar', 'detener', 'estado')]
  [string]$Accion = '',
  [int]$Puerto = 8080
)

$ErrorActionPreference = 'Stop'
$Raiz = $PSScriptRoot
$RtlTcp = Join-Path $Raiz 'tools\rtl-sdr-x64\rtl_tcp.exe'
$Servidor = Join-Path $Raiz 'server.js'
$Logs = Join-Path $Raiz 'logs'
$Url = "http://localhost:$Puerto"

# ---------------------------------------------------------------- servicios
function Get-ProcesosRtl {
  # Cualquier rtl_tcp.exe tiene el dongle ocupado, venga de donde venga
  @(Get-Process rtl_tcp -ErrorAction SilentlyContinue)
}

function Get-ProcesosServidor {
  # node.exe con el server.js de esta carpeta, aunque se arrancara desde otra consola:
  # o lleva la ruta completa en la línea de comandos, o es «node server.js» escuchando en nuestro puerto.
  $ruta = [regex]::Escape($Servidor)
  $escuchando = @(Get-NetTCPConnection -LocalPort $Puerto -State Listen -ErrorAction SilentlyContinue).OwningProcess
  @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and ($_.CommandLine -match $ruta -or ($_.CommandLine -match 'server\.js' -and $escuchando -contains $_.ProcessId)) })
}

function Get-Estado {
  $rtl = @(Get-ProcesosRtl)
  $srv = @(Get-ProcesosServidor)
  [pscustomobject]@{
    Rtl      = $rtl.Count -gt 0
    Servidor = $srv.Count -gt 0
    Texto    = if ($rtl.Count -and $srv.Count) { 'En marcha' }
               elseif ($rtl.Count) { 'Solo rtl_tcp (el RTL-SDR está ocupado)' }
               elseif ($srv.Count) { 'Solo el servidor web (RTL-SDR libre)' }
               else { 'Detenido (RTL-SDR libre)' }
  }
}

function Start-Servicios {
  if (-not (Test-Path $RtlTcp)) { throw "No encuentro $RtlTcp. Sigue el paso 4 de la instalación del README." }
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) { throw 'No encuentro Node.js. Instálalo (paso 1 del README).' }
  New-Item -ItemType Directory -Force $Logs | Out-Null

  if (-not @(Get-ProcesosRtl).Count) {
    Start-Process -FilePath $RtlTcp -ArgumentList '-a', '127.0.0.1', '-p', '1234' -WorkingDirectory (Split-Path $RtlTcp) `
      -WindowStyle Hidden -RedirectStandardOutput (Join-Path $Logs 'rtl_tcp.log') -RedirectStandardError (Join-Path $Logs 'rtl_tcp.err.log') | Out-Null
    Start-Sleep -Milliseconds 800
    if (-not @(Get-ProcesosRtl).Count) {
      $err = Get-Content (Join-Path $Logs 'rtl_tcp.err.log') -Tail 3 -ErrorAction SilentlyContinue
      throw "rtl_tcp no ha arrancado. ¿Está conectado el dongle y libre (sin SDR# abierto)?`n$($err -join "`n")"
    }
  }
  if (-not @(Get-ProcesosServidor).Count) {
    Start-Process -FilePath $node -ArgumentList "`"$Servidor`"", '--port', $Puerto -WorkingDirectory $Raiz `
      -WindowStyle Hidden -RedirectStandardOutput (Join-Path $Logs 'servidor.log') -RedirectStandardError (Join-Path $Logs 'servidor.err.log') | Out-Null
    for ($i = 0; $i -lt 20 -and -not @(Get-ProcesosServidor).Count; $i++) { Start-Sleep -Milliseconds 250 }
  }
}

function Stop-Servicios {
  # Primero el servidor (así no intenta reconectar), luego rtl_tcp, que es quien tiene el dongle
  Get-ProcesosServidor | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Get-ProcesosRtl | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
  for ($i = 0; $i -lt 20 -and (@(Get-ProcesosRtl).Count -or @(Get-ProcesosServidor).Count); $i++) { Start-Sleep -Milliseconds 150 }
}

# ---------------------------------------------------------------- modo consola
if ($Accion) {
  switch ($Accion) {
    'iniciar' { Start-Servicios }
    'detener' { Stop-Servicios }
  }
  $e = Get-Estado
  "rtl_tcp: $(if ($e.Rtl) {'en marcha'} else {'parado'}) | servidor: $(if ($e.Servidor) {"en marcha ($Url)"} else {'parado'}) | $($e.Texto)"
  return
}

# ---------------------------------------------------------------- icono en la bandeja
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

# Una sola instancia
$mutex = New-Object System.Threading.Mutex($false, 'Local\EscanerSdrBunkerHackerBandeja')
if (-not $mutex.WaitOne(0)) {
  [System.Windows.Forms.MessageBox]::Show('El icono del Escáner SDR ya está en la bandeja del sistema.', 'Escáner SDR') | Out-Null
  return
}

function New-Icono([System.Drawing.Color]$color) {
  # Onda de espectro sobre un cuadrado oscuro; el color indica el estado
  $bmp = New-Object System.Drawing.Bitmap 32, 32
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)
  $fondo = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 11, 18, 32))
  $g.FillRectangle($fondo, 1, 1, 30, 30)
  $pen = New-Object System.Drawing.Pen ($color, 3)
  $pen.LineJoin = 'Round'
  $pts = [System.Drawing.Point[]]@(
    [System.Drawing.Point]::new(3, 24), [System.Drawing.Point]::new(8, 22), [System.Drawing.Point]::new(11, 10),
    [System.Drawing.Point]::new(14, 21), [System.Drawing.Point]::new(17, 16), [System.Drawing.Point]::new(20, 22),
    [System.Drawing.Point]::new(23, 5), [System.Drawing.Point]::new(26, 22), [System.Drawing.Point]::new(29, 24))
  $g.DrawLines($pen, $pts)
  $g.Dispose()
  [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}
$IconoOn = New-Icono ([System.Drawing.Color]::FromArgb(255, 34, 211, 238))   # cian: en marcha
$IconoMedio = New-Icono ([System.Drawing.Color]::FromArgb(255, 251, 191, 36)) # ámbar: a medias
$IconoOff = New-Icono ([System.Drawing.Color]::FromArgb(255, 100, 116, 139))  # gris: detenido

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = $IconoOff
$tray.Text = 'Escáner SDR'
$tray.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$miTitulo = $menu.Items.Add('Escáner SDR de el Búnker Hacker')
$miTitulo.Enabled = $false
$miEstado = $menu.Items.Add('…')
$miEstado.Enabled = $false
$menu.Items.Add('-') | Out-Null
$miAbrir = $menu.Items.Add('Abrir el escáner')
$miAbrir.Font = New-Object System.Drawing.Font($miAbrir.Font, [System.Drawing.FontStyle]::Bold)
$miIniciar = $menu.Items.Add('▶  Iniciar servicios')
$miDetener = $menu.Items.Add('■  Detener y liberar el RTL-SDR')
$miReiniciar = $menu.Items.Add('↻  Reiniciar servicios')
$menu.Items.Add('-') | Out-Null
$miLogs = $menu.Items.Add('Ver registros')
$miInicioWin = $menu.Items.Add('Arrancar con Windows')
$menu.Items.Add('-') | Out-Null
$miSalir = $menu.Items.Add('Detener y salir')
$tray.ContextMenuStrip = $menu

$Atajo = Join-Path ([Environment]::GetFolderPath('Startup')) 'Escaner SDR.lnk'

function Update-Estado {
  $e = Get-Estado
  $tray.Icon = if ($e.Rtl -and $e.Servidor) { $IconoOn } elseif ($e.Rtl -or $e.Servidor) { $IconoMedio } else { $IconoOff }
  $t = "Escáner SDR — $($e.Texto)"
  $tray.Text = if ($t.Length -gt 63) { $t.Substring(0, 63) } else { $t }
  $miEstado.Text = "Estado: $($e.Texto)"
  $miAbrir.Enabled = $e.Servidor
  $miIniciar.Enabled = -not ($e.Rtl -and $e.Servidor)
  $miDetener.Enabled = $e.Rtl -or $e.Servidor
  $miReiniciar.Enabled = $e.Rtl -or $e.Servidor
  $miInicioWin.Checked = Test-Path $Atajo
}

function Invoke-Seguro([scriptblock]$accion, [string]$aviso) {
  try {
    [System.Windows.Forms.Cursor]::Current = [System.Windows.Forms.Cursors]::WaitCursor
    & $accion
    if ($aviso) { $tray.ShowBalloonTip(3000, 'Escáner SDR', $aviso, 'Info') }
  } catch {
    $tray.ShowBalloonTip(6000, 'Escáner SDR', $_.Exception.Message, 'Error')
  } finally {
    [System.Windows.Forms.Cursor]::Current = [System.Windows.Forms.Cursors]::Default
    Update-Estado
  }
}

$miAbrir.Add_Click({ Start-Process $Url })
$tray.Add_DoubleClick({ if ((Get-Estado).Servidor) { Start-Process $Url } })
$miIniciar.Add_Click({ Invoke-Seguro { Start-Servicios } "Servicios en marcha: $Url" })
$miDetener.Add_Click({ Invoke-Seguro { Stop-Servicios } 'Servicios detenidos. El RTL-SDR está libre.' })
$miReiniciar.Add_Click({ Invoke-Seguro { Stop-Servicios; Start-Servicios } 'Servicios reiniciados.' })
$miLogs.Add_Click({ New-Item -ItemType Directory -Force $Logs | Out-Null; Start-Process explorer.exe $Logs })
$miInicioWin.Add_Click({
  if (Test-Path $Atajo) { Remove-Item $Atajo -Force }
  else {
    $sh = New-Object -ComObject WScript.Shell
    $lnk = $sh.CreateShortcut($Atajo)
    $lnk.TargetPath = Join-Path $Raiz 'Escaner SDR.cmd'
    $lnk.WorkingDirectory = $Raiz
    $lnk.WindowStyle = 7 # minimizada
    $lnk.Description = 'Escáner SDR de el Búnker Hacker'
    $lnk.Save()
  }
  Update-Estado
})
$miSalir.Add_Click({
  Stop-Servicios
  $tray.Visible = $false
  [System.Windows.Forms.Application]::Exit()
})

# Refrescar el estado cada 3 s (por si algo se para o se arranca desde fuera)
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.Add_Tick({ Update-Estado })
$timer.Start()

# Al abrir el icono se arrancan los servicios
Update-Estado
Invoke-Seguro { Start-Servicios } "Escáner en marcha: $Url"

[System.Windows.Forms.Application]::Run()
$timer.Stop()
$tray.Dispose()
$mutex.ReleaseMutex()
