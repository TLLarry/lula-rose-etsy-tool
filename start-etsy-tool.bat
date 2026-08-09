@echo off
rem Double-clickable wrapper so the desktop shortcut can start the app.
rem All the real work is in start-etsy-tool.ps1, next to this file.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-etsy-tool.ps1"
