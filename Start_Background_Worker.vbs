Set WshShell = CreateObject("WScript.Shell")
Set objFSO = CreateObject("Scripting.FileSystemObject")

' Get the folder where this VBS script is located
strScriptFolder = objFSO.GetParentFolderName(WScript.ScriptFullName)

' Set the working directory to the script's folder
WshShell.CurrentDirectory = strScriptFolder

' 0 means hide the window completely
' False means do not wait for the command to finish
' Run npm install just in case, then install pm2, then use npx to guarantee windows finds it!
WshShell.Run "cmd.exe /c npm install && npm install -g pm2 && npx pm2 start worker.js --name supabase-sync && npx pm2 save", 0, False
