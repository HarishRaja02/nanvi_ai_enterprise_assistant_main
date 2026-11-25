"""Generates personalized single-click Windows connector packages for users.

Every user receives a self-contained Nanvi_Assistant.bat that extracts and launches
the native white Nanvi Local Connector desktop application (`nanvi_gui_agent.pyw`)
completely detached via `pythonw.exe` (zero lingering black CMD window) with a
Start Menu shortcut and automatic Python detection.
"""
from __future__ import annotations

import io
import json
import base64
import re
import zipfile
from pathlib import Path


def _sanitize_batch_arg(value: str) -> str:
    """Strip characters that could break cmd.exe batch quoting or allow injection."""
    return re.sub(r'["\r\n&|<>^%`$;]', "", (value or "").strip())


def _load_gui_agent_source() -> str:
    """Load the native Windows Tkinter GUI agent (with CLI fallback)."""
    base_dir = Path(__file__).resolve().parent
    gui_path = base_dir / "gui_agent.py"
    if gui_path.exists():
        return gui_path.read_text(encoding="utf-8")

    cli_path = base_dir / "client_agent.py"
    if cli_path.exists():
        return cli_path.read_text(encoding="utf-8")

    legacy_path = base_dir.parents[1] / "local_agent" / "nanvi_local_agent.py"
    return legacy_path.read_text(encoding="utf-8")


def _encode_base64_echo_lines(source: str) -> str:
    b64_code = base64.b64encode(source.encode("utf-8")).decode("ascii")
    return "\n".join(f"echo {b64_code[i : i + 64]}" for i in range(0, len(b64_code), 64))


def generate_agent_bat(server_url: str, pairing_token: str, display_name: str = "") -> str:
    """Generate a single self-contained Nanvi_Assistant.bat launching the white GUI app."""
    clean_server = _sanitize_batch_arg(server_url.rstrip("/")) or "http://127.0.0.1:8000"
    clean_token = _sanitize_batch_arg(pairing_token)
    clean_name = _sanitize_batch_arg(display_name or "Enterprise User")

    agent_code = _load_gui_agent_source()
    b64_lines = _encode_base64_echo_lines(agent_code)

    script = f"""@echo off
setlocal enabledelayedexpansion
title Nanvi Assistant - Local File Agent

set "NANVI_DIR=%LOCALAPPDATA%\\NanviAgent"
if not exist "%NANVI_DIR%" mkdir "%NANVI_DIR%"

set "TARGET_PYW=%NANVI_DIR%\\nanvi_gui_agent.pyw"
set "B64_TMP=%NANVI_DIR%\\agent.b64"
set "CONFIG_JSON=%NANVI_DIR%\\config.json"

echo Preparing Nanvi Local Connector...

:: -------------------------------------------------------------------------
:: 1. Extract embedded native Windows GUI connector (nanvi_gui_agent.pyw)
:: -------------------------------------------------------------------------
(
echo -----BEGIN CERTIFICATE-----
{b64_lines}
echo -----END CERTIFICATE-----
) > "%B64_TMP%"

certutil -f -decode "%B64_TMP%" "%TARGET_PYW%" >nul 2>&1
if exist "%B64_TMP%" del "%B64_TMP%" >nul 2>&1

if not exist "%TARGET_PYW%" (
    powershell -NoProfile -Command "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('Could not unpack Nanvi Local Connector to %NANVI_DIR%. Please check folder permissions.', 'Nanvi Local Connector', 'OK', 'Error')" >nul 2>&1
    exit /b 1
)

if not exist "%CONFIG_JSON%" (
    (
        echo {{
        echo   "server_url": "{clean_server}",
        echo   "token": "{clean_token}",
        echo   "display_name": "{clean_name}",
        echo   "folders": []
        echo }}
    ) > "%CONFIG_JSON%"
)

:: -------------------------------------------------------------------------
:: 2. Locate real Python / pythonw.exe (skip fake Microsoft Store stubs)
:: -------------------------------------------------------------------------
set "PYTHON_EXE="
set "PYTHONW_EXE="

where py >nul 2>&1
if %errorlevel% equ 0 (
    for /f "delims=" %%I in ('py -3 -c "import sys, tkinter; print(sys.executable)" 2^>nul') do (
        if not defined PYTHON_EXE set "PYTHON_EXE=%%I"
    )
)

if not defined PYTHON_EXE (
    for /f "delims=" %%I in ('where python 2^>nul') do (
        if not defined PYTHON_EXE (
            echo "%%I" | findstr /I /C:"\\WindowsApps\\python.exe" >nul
            if errorlevel 1 (
                "%%I" -c "import tkinter" >nul 2>&1 && set "PYTHON_EXE=%%I"
            )
        )
    )
)

if not defined PYTHON_EXE (
    for /d %%D in ("%LOCALAPPDATA%\\Programs\\Python\\Python3*" "%ProgramFiles%\\Python3*" "C:\\Python3*") do (
        if not defined PYTHON_EXE if exist "%%~D\\python.exe" (
            "%%~D\\python.exe" -c "import tkinter" >nul 2>&1 && set "PYTHON_EXE=%%~D\\python.exe"
        )
    )
)

:: Check actual Microsoft Store Python install only if appx package folder exists
if not defined PYTHON_EXE (
    dir "%LOCALAPPDATA%\\Microsoft\\WindowsApps\\PythonSoftwareFoundation.Python.*" >nul 2>&1
    if not errorlevel 1 (
        for /f "delims=" %%I in ('where python 2^>nul') do (
            if not defined PYTHON_EXE "%%I" -c "import tkinter" >nul 2>&1 && set "PYTHON_EXE=%%I"
        )
    )
)

:: -------------------------------------------------------------------------
:: 3. Auto-install Python via Winget on first run if missing on laptop
:: -------------------------------------------------------------------------
if not defined PYTHON_EXE (
    where winget >nul 2>&1
    if %errorlevel% equ 0 (
        echo First-time setup: Installing Python runtime for Nanvi Local Connector...
        winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements --silent >nul 2>&1
        for /d %%D in ("%LOCALAPPDATA%\\Programs\\Python\\Python3*" "%ProgramFiles%\\Python3*") do (
            if not defined PYTHON_EXE if exist "%%~D\\python.exe" (
                "%%~D\\python.exe" -c "import tkinter" >nul 2>&1 && set "PYTHON_EXE=%%~D\\python.exe"
            )
        )
    )
)

if not defined PYTHON_EXE (
    powershell -NoProfile -Command "Add-Type -AssemblyName PresentationFramework; $r = [System.Windows.MessageBox]::Show('Python 3 is required for the first-time setup of Nanvi Local Connector on this PC.`n`nClick YES to open the official Python download page now.', 'Nanvi Local Connector - Setup', 'YesNo', 'Information'); if ($r -eq 'Yes') {{ Start-Process 'https://www.python.org/downloads/' }}" >nul 2>&1
    exit /b 1
)

for %%F in ("%PYTHON_EXE%") do set "PY_DIR=%%~dpF"
if exist "%PY_DIR%pythonw.exe" (
    set "PYTHONW_EXE=%PY_DIR%pythonw.exe"
) else (
    for /f "delims=" %%W in ('where pythonw 2^>nul') do (
        if not defined PYTHONW_EXE (
            echo "%%W" | findstr /I /C:"\\WindowsApps\\pythonw.exe" >nul
            if errorlevel 1 set "PYTHONW_EXE=%%W"
        )
    )
)

:: -------------------------------------------------------------------------
:: 4. Create official Windows Start Menu shortcut for future 1-click launch
:: -------------------------------------------------------------------------
set "LAUNCH_TARGET=%PYTHONW_EXE%"
if not defined LAUNCH_TARGET set "LAUNCH_TARGET=%PYTHON_EXE%"

powershell -NoProfile -Command "try {{ $ws = New-Object -ComObject WScript.Shell; $d = Join-Path $env:LOCALAPPDATA 'NanviAgent'; $lnk = $ws.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Programs')) 'Nanvi Local Connector.lnk')); $lnk.TargetPath = $env:LAUNCH_TARGET; $lnk.Arguments = '\"' + (Join-Path $d 'nanvi_gui_agent.pyw') + '\"'; $lnk.WorkingDirectory = $d; $lnk.Description = 'Nanvi AI Enterprise Assistant Local File Connector'; $lnk.Save() }} catch {{}}" >nul 2>&1

:: -------------------------------------------------------------------------
:: 5. Launch native white GUI detached (zero black CMD terminal window)
:: -------------------------------------------------------------------------
set "NANVI_SERVER={clean_server}"
set "NANVI_TOKEN={clean_token}"
if defined PYTHONW_EXE (
    start "" "%PYTHONW_EXE%" "%TARGET_PYW%" --server "%NANVI_SERVER%" --token "%NANVI_TOKEN%"
) else (
    powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath $env:PYTHON_EXE -ArgumentList (Join-Path $env:NANVI_DIR 'nanvi_gui_agent.pyw'),'--server',$env:NANVI_SERVER,'--token',$env:NANVI_TOKEN -WindowStyle Hidden" >nul 2>&1
)

exit /b 0
"""
    return script.replace("\n", "\r\n")


def generate_agent_zip(server_url: str, pairing_token: str, display_name: str = "") -> bytes:
    """Generate a ZIP archive containing nanvi_gui_agent.pyw, config.json, and Start_Nanvi_Agent.bat."""
    clean_server = _sanitize_batch_arg(server_url.rstrip("/")) or "http://127.0.0.1:8000"
    clean_token = _sanitize_batch_arg(pairing_token)
    agent_code = _load_gui_agent_source()

    config_json = json.dumps(
        {
            "server_url": clean_server,
            "token": clean_token,
            "display_name": display_name or "Enterprise User",
            "folders": [],
        },
        indent=2,
    )

    launcher_bat = """@echo off
setlocal
title Nanvi Local Connector
set "PYTHONW_EXE="
where pythonw >nul 2>&1
if %errorlevel% equ 0 (
    for /f "delims=" %%W in ('where pythonw 2^>nul') do (
        if not defined PYTHONW_EXE (
            echo "%%W" | findstr /I /C:"\\WindowsApps\\pythonw.exe" >nul
            if errorlevel 1 set "PYTHONW_EXE=%%W"
        )
    )
)
if defined PYTHONW_EXE (
    start "" "%PYTHONW_EXE%" "%~dp0nanvi_gui_agent.pyw"
    exit /b 0
)
where pyw >nul 2>&1
if %errorlevel% equ 0 (
    start "" pyw -3 "%~dp0nanvi_gui_agent.pyw"
    exit /b 0
)
start "" python "%~dp0nanvi_gui_agent.pyw"
exit /b 0
"""

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("Nanvi_Local_Agent/nanvi_gui_agent.pyw", agent_code)
        zf.writestr("Nanvi_Local_Agent/config.json", config_json)
        zf.writestr("Nanvi_Local_Agent/Start_Nanvi_Agent.bat", launcher_bat.replace("\n", "\r\n"))

    return buf.getvalue()
