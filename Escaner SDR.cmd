@echo off
rem Escaner SDR de el Bunker Hacker: abre el icono de la bandeja del sistema,
rem que arranca rtl_tcp y el servidor web sin ventanas.
rem -ExecutionPolicy Bypass solo afecta a este proceso de PowerShell (no cambia la configuracion de Windows).
start "" powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0bandeja.ps1"
