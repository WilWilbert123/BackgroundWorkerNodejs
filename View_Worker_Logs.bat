@echo off
echo =======================================================
echo Viewing Live Logs for the Invisible Supabase-Sync Worker
echo (Press Ctrl+C to close this log view. The worker will STILL run in the background!)
echo =======================================================
echo.

npx pm2 logs supabase-sync

pause
