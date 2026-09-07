@echo off
rem [codexskin] Self-heal: re-apply Dream Skin patches to @codexhost/cli after
rem any npm update (idempotent no-op when already patched).
IF EXIST "%LOCALAPPDATA%\CodexDreamSkin\patch-codexhost.mjs" node "%LOCALAPPDATA%\CodexDreamSkin\patch-codexhost.mjs" --quiet >NUL 2>&1
rem Align Codex Dream Skin with the Codex Desktop instance that is running now
rem (including instances started by codexhost). Waits up to 120s for Codex.
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0sync-dreamskin-port.ps1" -WaitSeconds 120 %*
echo.
pause
