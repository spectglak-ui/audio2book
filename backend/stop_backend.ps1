# Arrete le backend Audio2Book s'il tourne en arriere-plan
$processes = Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -like "*uvicorn app.main:app*" }

if ($processes) {
    $processes | ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force
        Write-Host "Processus $($_.ProcessId) arrete."
    }
    Write-Host "Backend Audio2Book arrete."
} else {
    Write-Host "Aucun backend Audio2Book en cours d'execution."
}