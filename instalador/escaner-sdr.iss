; Instalador de Windows del Escáner SDR de el Búnker Hacker (Inno Setup 6)
; No se compila a mano: usa instalador\construir.ps1, que prepara build\app y pasa estas variables.

#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
#ifndef Stage
  #define Stage "..\build\app"
#endif
#ifndef Dist
  #define Dist "..\dist"
#endif

#define AppName "Escáner SDR de el Búnker Hacker"
#define AppShort "Escáner SDR"
#define PS "{sys}\WindowsPowerShell\v1.0\powershell.exe"
; Comillas dobladas a propósito: se insertan dentro de valores Parameters: "..."
#define LanzarArgs '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""{app}\bandeja.ps1""'

[Setup]
AppId={{8F3C2A51-6D4B-4E7A-9C1F-2B5E8D7A4C90}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=El Búnker Hacker
AppPublisherURL=https://github.com/elbunkerhacker/Escaner-Sdr
AppSupportURL=https://github.com/elbunkerhacker/Escaner-Sdr/issues
AppUpdatesURL=https://github.com/elbunkerhacker/Escaner-Sdr/releases
; Sin permisos de administrador: se instala para el usuario en %LOCALAPPDATA%\Programs
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
DefaultDirName={autopf}\Escaner SDR
DefaultGroupName={#AppShort}
DisableProgramGroupPage=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#Dist}
OutputBaseFilename=EscanerSDR-Setup-{#AppVersion}
SetupIconFile={#Stage}\escaner.ico
UninstallDisplayIcon={app}\escaner.ico
UninstallDisplayName={#AppName}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=no
VersionInfoVersion={#AppVersion}
VersionInfoProductName={#AppName}
VersionInfoDescription=Instalador del {#AppName}

[Languages]
Name: "es"; MessagesFile: "compiler:Languages\Spanish.isl"

[Tasks]
Name: "escritorio"; Description: "Crear un acceso directo en el &Escritorio"; GroupDescription: "Accesos directos:"
Name: "inicio"; Description: "Arrancar el escáner al &iniciar Windows"; GroupDescription: "Accesos directos:"; Flags: unchecked

[Files]
Source: "{#Stage}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Dirs]
; Bandas, frecuencias y etiquetas del usuario: se conservan al desinstalar
Name: "{app}\data"; Flags: uninsneveruninstall
Name: "{app}\logs"

[Icons]
Name: "{group}\{#AppShort}"; Filename: "{#PS}"; Parameters: "{#LanzarArgs}"; WorkingDir: "{app}"; IconFilename: "{app}\escaner.ico"; Comment: "Abre el icono de la bandeja y arranca el escáner"
Name: "{group}\Instalar driver USB del RTL-SDR (Zadig)"; Filename: "{app}\drivers\zadig.exe"; WorkingDir: "{app}\drivers"
Name: "{group}\Guía de uso"; Filename: "https://github.com/elbunkerhacker/Escaner-Sdr#readme"
Name: "{group}\Desinstalar {#AppShort}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppShort}"; Filename: "{#PS}"; Parameters: "{#LanzarArgs}"; WorkingDir: "{app}"; IconFilename: "{app}\escaner.ico"; Comment: "Abre el icono de la bandeja y arranca el escáner"; Tasks: escritorio
Name: "{userstartup}\{#AppShort}"; Filename: "{#PS}"; Parameters: "{#LanzarArgs}"; WorkingDir: "{app}"; IconFilename: "{app}\escaner.ico"; Tasks: inicio

[Run]
Filename: "{app}\drivers\zadig.exe"; Description: "Instalar el driver USB del RTL-SDR con Zadig (necesario la primera vez)"; Flags: postinstall shellexec skipifsilent; Check: NecesitaDriver
Filename: "{#PS}"; Parameters: "{#LanzarArgs}"; WorkingDir: "{app}"; Description: "Iniciar el {#AppShort} ahora"; Flags: postinstall nowait skipifsilent runhidden

[UninstallRun]
Filename: "{#PS}"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\bandeja.ps1"" -Accion cerrar"; Flags: runhidden waituntilterminated; RunOnceId: "CerrarEscaner"

[UninstallDelete]
Type: filesandordirs; Name: "{app}\logs"

[Code]
var
  EstadoDriver: Integer;

function PowerShell(): String;
begin
  Result := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
end;

function InitializeSetup(): Boolean;
begin
  EstadoDriver := -1;
  Result := True;
end;

{ Si hay una versión instalada en marcha, se para (y se libera el RTL-SDR) antes de copiar archivos }
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  rc: Integer;
  Script: String;
begin
  Script := ExpandConstant('{app}\bandeja.ps1');
  if FileExists(Script) then
    Exec(PowerShell(), '-NoProfile -ExecutionPolicy Bypass -File "' + Script + '" -Accion cerrar', '', SW_HIDE, ewWaitUntilTerminated, rc);
  Result := '';
end;

{ 0 = driver WinUSB correcto, 1 = dongle conectado sin driver, 2 = no se ha visto ningún dongle }
function NecesitaDriver(): Boolean;
var
  rc: Integer;
begin
  if EstadoDriver < 0 then
  begin
    if Exec(PowerShell(), '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\comprobar-driver.ps1') + '"', '', SW_HIDE, ewWaitUntilTerminated, rc) then
      EstadoDriver := rc
    else
      EstadoDriver := 1;
  end;
  Result := EstadoDriver <> 0;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = wpFinished then
  begin
    if NecesitaDriver() then
    begin
      if EstadoDriver = 2 then
        WizardForm.FinishedLabel.Caption := WizardForm.FinishedLabel.Caption + #13#10#13#10 +
          'No se ha detectado ningún RTL-SDR. Conéctalo y, si es la primera vez que lo usas en este equipo, ' +
          'abre «Instalar driver USB del RTL-SDR (Zadig)» desde el menú Inicio.'
      else
        WizardForm.FinishedLabel.Caption := WizardForm.FinishedLabel.Caption + #13#10#13#10 +
          'Tu RTL-SDR todavía no tiene el driver WinUSB. Deja marcada la casilla de Zadig y, en Zadig: ' +
          'Options › List All Devices › «Bulk-In, Interface (Interface 0)» › WinUSB › Replace Driver.';
    end;
  end;
end;
