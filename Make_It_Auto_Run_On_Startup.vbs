Set WshShell = CreateObject("WScript.Shell")
Set objFSO = CreateObject("Scripting.FileSystemObject")

' Find the Windows Startup folder
strStartupFolder = WshShell.SpecialFolders("Startup")

' Get the exact path to where this folder is located right now
strScriptFolder = objFSO.GetParentFolderName(WScript.ScriptFullName)
strTargetScript = strScriptFolder & "\Start_Background_Worker.vbs"

' Create a shortcut in the Windows Startup folder
Set objShortcut = WshShell.CreateShortcut(strStartupFolder & "\Supabase_Worker_Startup.lnk")
objShortcut.TargetPath = strTargetScript
objShortcut.WorkingDirectory = strScriptFolder
objShortcut.Description = "Auto-starts the Supabase to MSSQL background worker"
objShortcut.Save

WScript.Echo "Success! The worker will now automatically start completely invisibly every time this computer is turned on or rebooted."
