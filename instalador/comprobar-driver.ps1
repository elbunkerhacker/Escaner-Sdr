# Comprueba si el RTL-SDR tiene un driver USB que sirva para rtl_tcp (WinUSB, libusbK o libusb0).
# Lo usa el instalador para decidir si ofrece abrir Zadig.
#   Código de salida: 0 = driver correcto, 1 = dongle conectado sin driver, 2 = no se ha visto ningún dongle
# Busca también dongles que ya no están conectados: si alguna vez tuvo WinUSB, Windows lo recuerda.

$ids = 'VID_0BDA&PID_2838', 'VID_0BDA&PID_2832'
$disp = @(Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object {
    $i = $_.InstanceId
    ($ids | Where-Object { $i -match [regex]::Escape($_) }) -and ($i -match '&MI_00' -or $i -notmatch '&MI_')
  })

foreach ($d in $disp) {
  $svc = (Get-PnpDeviceProperty -InstanceId $d.InstanceId -KeyName DEVPKEY_Device_Service -ErrorAction SilentlyContinue).Data
  if ($svc -match '^(WinUSB|libusbK|libusb0)$') { exit 0 }
}
if (@($disp | Where-Object Present).Count) { exit 1 }
exit 2
