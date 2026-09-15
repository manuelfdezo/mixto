# Prepara este ordenador para Mixto y lo abre. Lo llama Abrir-Mixto.cmd.
# Con -Cerrar detiene el servidor; con -Terminal deja abierta una consola con las herramientas en el PATH.
# Todo lo que descarga queda dentro de la carpeta de Mixto, en .runtime: no toca el resto del sistema.
param(
  [switch]$Cerrar,
  [switch]$Terminal
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

$root = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $root '.runtime'
$nodeDir = Join-Path $runtime 'node'
$gitDir = Join-Path $runtime 'git'
$marker = Join-Path $runtime 'preparado.txt'
$url = 'http://127.0.0.1:4317'
$arch = 'x64'
if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { $arch = 'arm64' }
$minNode = 22

function Say($text) { Write-Host $text }
function Ask($question) {
  $answer = Read-Host "$question [S/N]"
  return ($answer -match '^\s*(s|si|sí|y|yes)\s*$')
}
function Add-ToPath($dir) {
  if ($dir -and (Test-Path $dir)) {
    $parts = $env:Path -split ';'
    if ($parts -notcontains $dir) { $env:Path = "$dir;$env:Path" }
  }
}
function Get-NodeMajor($exe) {
  try {
    $v = & $exe -v 2>$null
    if ($v -match '^v(\d+)\.') { return [int]$Matches[1] }
  } catch {}
  return 0
}
function Find-Node {
  $portable = Join-Path $nodeDir 'node.exe'
  if (Test-Path $portable) { return $portable }
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmd -and ((Get-NodeMajor $cmd.Source) -ge $minNode)) { return $cmd.Source }
  return $null
}
function Find-Git {
  $portable = Join-Path $gitDir 'cmd\git.exe'
  if (Test-Path $portable) { return $portable }
  $cmd = Get-Command git.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}
function Find-Cli($name) {
  $cmd = Get-Command "$name.cmd", "$name.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cmd) { return $cmd.Source }
  return $null
}
function Get-Download($uri, $target) {
  Say "  Descargando $uri"
  Invoke-WebRequest -UseBasicParsing -Uri $uri -OutFile $target
}
function Install-Node {
  $base = 'https://nodejs.org/dist/latest-v24.x/'
  $sums = (Invoke-WebRequest -UseBasicParsing -Uri ($base + 'SHASUMS256.txt')).Content
  $line = ($sums -split "`n") | Where-Object { $_ -match ("node-v24\.[\d.]+-win-" + $arch + "\.zip") } | Select-Object -First 1
  if (-not $line) { throw "No se encontró Node.js 24 para Windows $arch." }
  $parts = $line.Trim() -split '\s+'
  $sha = $parts[0]
  $zipName = $parts[1]
  $zip = Join-Path $env:TEMP $zipName
  Get-Download ($base + $zipName) $zip
  $actual = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLower()
  if ($actual -ne $sha.ToLower()) { Remove-Item $zip -Force; throw 'La descarga de Node.js no coincide con su suma de comprobación; inténtalo de nuevo.' }
  Say '  Descomprimiendo (tarda un minuto)...'
  $tmp = Join-Path $env:TEMP ('mixto-node-' + [guid]::NewGuid().ToString())
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $inner = Get-ChildItem -Path $tmp -Directory | Select-Object -First 1
  if (Test-Path $nodeDir) { Remove-Item $nodeDir -Recurse -Force }
  New-Item -ItemType Directory -Path $runtime -Force | Out-Null
  Move-Item -Path $inner.FullName -Destination $nodeDir
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $zip -Force -ErrorAction SilentlyContinue
  Say ('  Node.js ' + (& (Join-Path $nodeDir 'node.exe') -v) + ' listo en .runtime\node')
}
function Get-MinGitAsset {
  # El MinGit más reciente: por la API de GitHub, por la redirección de «latest» o, si nada responde, una versión conocida.
  $pattern = '^MinGit-[\d.]+-64-bit\.zip$'
  $suffix = '64-bit'
  if ($arch -eq 'arm64') { $pattern = '^MinGit-[\d.]+-arm64\.zip$'; $suffix = 'arm64' }
  try {
    $release = Invoke-RestMethod -UseBasicParsing -Uri 'https://api.github.com/repos/git-for-windows/git/releases/latest' -Headers @{ 'User-Agent' = 'Mixto' } -TimeoutSec 30
    $asset = $release.assets | Where-Object { $_.name -match $pattern } | Select-Object -First 1
    if ($asset) { return @{ name = $asset.name; url = $asset.browser_download_url } }
  } catch {}
  $tag = $null
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/git-for-windows/git/releases/latest' -MaximumRedirection 0 -TimeoutSec 30 -ErrorAction SilentlyContinue
    $location = [string]$response.Headers['Location']
    if ($location -match '/tag/(v[\d.]+\.windows\.\d+)$') { $tag = $Matches[1] }
  } catch {
    try {
      $location = [string]$_.Exception.Response.Headers['Location']
      if ($location -match '/tag/(v[\d.]+\.windows\.\d+)$') { $tag = $Matches[1] }
    } catch {}
  }
  if (-not $tag) { $tag = 'v2.51.0.windows.1' }
  $version = $tag -replace '^v', '' -replace '\.windows\.1$', '' -replace '\.windows\.(\d+)$', '.$1'
  $name = "MinGit-$version-$suffix.zip"
  return @{ name = $name; url = "https://github.com/git-for-windows/git/releases/download/$tag/$name" }
}
function Install-Git {
  $asset = Get-MinGitAsset
  $zip = Join-Path $env:TEMP $asset.name
  Get-Download $asset.url $zip
  Say '  Descomprimiendo...'
  if (Test-Path $gitDir) { Remove-Item $gitDir -Recurse -Force }
  New-Item -ItemType Directory -Path $runtime -Force | Out-Null
  Expand-Archive -Path $zip -DestinationPath $gitDir -Force
  Remove-Item $zip -Force -ErrorAction SilentlyContinue
  Say ('  Git listo en .runtime\git (' + $asset.name + ')')
}
function Get-Npm($node) {
  $npm = Join-Path (Split-Path -Parent $node) 'npm.cmd'
  if (Test-Path $npm) { return $npm }
  $cmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  throw 'No se encontró npm junto a Node.js.'
}
function Install-Cli($node, $package) {
  $npm = Get-Npm $node
  $extra = @()
  if ($node -eq (Join-Path $nodeDir 'node.exe')) { $extra = @('--prefix', $nodeDir) }
  & $npm install -g $package --no-fund --no-audit @extra
  if ($LASTEXITCODE -ne 0) { throw "npm no pudo instalar $package." }
}
function Add-NpmPrefixToPath($node) {
  try {
    $npm = Get-Npm $node
    $prefix = (& $npm prefix -g 2>$null | Select-Object -Last 1)
    if ($prefix) { Add-ToPath $prefix.Trim() }
  } catch {}
}
function New-DesktopShortcut {
  $desktop = [Environment]::GetFolderPath('Desktop')
  $shell = New-Object -ComObject WScript.Shell
  $link = $shell.CreateShortcut((Join-Path $desktop 'Mixto.lnk'))
  $link.TargetPath = Join-Path $root 'Abrir-Mixto.cmd'
  $link.WorkingDirectory = $root
  $link.IconLocation = (Join-Path $root 'dist\mixto.ico') + ',0'
  $link.Description = 'Mixto: Claude Code y Codex en tu ordenador'
  $link.Save()
}

Add-ToPath $nodeDir
Add-ToPath (Join-Path $gitDir 'cmd')

if ($Cerrar) {
  try {
    $health = Invoke-RestMethod -UseBasicParsing -Uri ($url + '/api/health') -TimeoutSec 3
    if ($health.app -ne 'mixto') { throw 'El servicio local no es Mixto.' }
    Invoke-WebRequest -UseBasicParsing -Uri ($url + '/') -SessionVariable session | Out-Null
    Invoke-WebRequest -UseBasicParsing -Method Post -Uri ($url + '/api/shutdown') -WebSession $session -Headers @{ 'X-Mixto-Client' = '1' } -ContentType 'application/json' -Body '{}' | Out-Null
    Say 'Mixto se ha cerrado. Tus conversaciones y recuerdos siguen guardados.'
  } catch {
    Say ('Mixto no está abierto o no se pudo cerrar: ' + $_.Exception.Message)
  }
  exit 0
}

$node = Find-Node
if ($node) { Add-NpmPrefixToPath $node }
$git = Find-Git
$codex = Find-Cli 'codex'
$claude = Find-Cli 'claude'

if ($Terminal) {
  Set-Location $root
  Say 'Terminal de Mixto: aquí funcionan node, npm, git, codex y claude aunque no estén instalados en el sistema.'
  Say 'Para iniciar sesión en los agentes: codex login  y  claude auth login'
  if (-not $node) { Say 'Todavía no hay Node.js: abre Mixto una vez con Abrir-Mixto.cmd para instalarlo.' }
  return
}

$missing = @()
if (-not $node) { $missing += 'Node.js 24 (unos 30 MB, queda dentro de la carpeta de Mixto)' }
if (-not $git) { $missing += 'Git (MinGit, unos 40 MB, queda dentro de la carpeta de Mixto)' }
if (-not $codex) { $missing += 'Codex (paquete @openai/codex, con npm)' }
if (-not $claude) { $missing += 'Claude Code (paquete @anthropic-ai/claude-code, con npm)' }

if ($missing.Count -gt 0) {
  Say ''
  Say 'Mixto necesita instalar:'
  foreach ($item in $missing) { Say "  - $item" }
  Say 'Nada de esto cambia el resto del sistema. Puedes borrar la carpeta .runtime para deshacerlo.'
  Say ''
  if (-not (Ask '¿Instalar ahora?')) { Say 'Sin instalar. Vuelve a abrir Mixto cuando quieras.'; exit 1 }
  if (-not $node) { Say 'Instalando Node.js...'; Install-Node; $node = Find-Node; Add-ToPath $nodeDir }
  if (-not $git) { Say 'Instalando Git...'; Install-Git; $git = Find-Git; Add-ToPath (Join-Path $gitDir 'cmd') }
  if (-not $codex) { Say 'Instalando Codex...'; Install-Cli $node '@openai/codex' }
  if (-not $claude) { Say 'Instalando Claude Code...'; Install-Cli $node '@anthropic-ai/claude-code' }
  Add-NpmPrefixToPath $node
  $codex = Find-Cli 'codex'
  $claude = Find-Cli 'claude'
  if (-not $codex) { Say 'Codex se instaló pero no aparece en el PATH; abre Terminal-Mixto.cmd y escribe codex para comprobarlo.' }
  if (-not $claude) { Say 'Claude Code se instaló pero no aparece en el PATH; abre Terminal-Mixto.cmd y escribe claude para comprobarlo.' }
}

if (-not (Test-Path $marker)) {
  # Primera vez: quitar la marca «descargado de internet» de los archivos de Mixto, identidad de git, sesiones y acceso directo.
  Get-ChildItem -Path $root -Recurse -File | Where-Object { $_.FullName -notlike ($runtime + '*') -and $_.FullName -notlike ((Join-Path $root 'data') + '*') } | Unblock-File -ErrorAction SilentlyContinue
  if ($git) {
    $email = ''
    try { $email = (& $git config --global --get user.email 2>$null) } catch {}
    if (-not $email) {
      Say ''
      Say 'Git no tiene tu nombre y correo: hacen falta para confirmar cambios y para la cooperación por git.'
      $name = Read-Host 'Tu nombre (vacío para saltar)'
      if ($name) {
        $mail = Read-Host 'Tu correo'
        & $git config --global user.name $name
        if ($mail) { & $git config --global user.email $mail }
      }
    }
  }
  Say ''
  if ($codex -and (Ask '¿Iniciar sesión en Codex ahora? (abre el navegador)')) { try { & $codex login } catch { Say ('No se pudo iniciar sesión en Codex: ' + $_.Exception.Message) } }
  if ($claude -and (Ask '¿Iniciar sesión en Claude Code ahora? (abre el navegador)')) { try { & $claude auth login } catch { Say ('No se pudo iniciar sesión en Claude Code: ' + $_.Exception.Message) } }
  if (Ask '¿Crear un acceso directo «Mixto» en el escritorio?') { try { New-DesktopShortcut; Say '  Acceso directo creado.' } catch { Say ('  No se pudo crear el acceso directo: ' + $_.Exception.Message) } }
  New-Item -ItemType Directory -Path $runtime -Force | Out-Null
  Set-Content -Path $marker -Value ('Preparado el ' + (Get-Date -Format 'yyyy-MM-dd HH:mm'))
  Say ''
  Say 'Listo. A partir de ahora Abrir-Mixto.cmd abre Mixto directamente; Terminal-Mixto.cmd abre una consola con las herramientas.'
}

if (-not $node) { Say 'No hay Node.js disponible; no se puede abrir Mixto.'; exit 1 }
& $node (Join-Path $root 'scripts\launch.mjs')
exit $LASTEXITCODE
