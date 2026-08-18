@echo off
setlocal
if not exist "worker.pid" (
    echo The background worker is not currently running ^(or the PID file is missing^).
    pause
    exit /b
)

:: Read the process ID from the file
set /p WORKER_PID=<worker.pid

:: Force kill the node process with that exact ID
echo Stopping worker with Process ID: %WORKER_PID%...
taskkill /F /PID %WORKER_PID%

:: Delete the PID file so we know it's stopped
del worker.pid

echo.
echo Worker has been completely stopped!
pause
