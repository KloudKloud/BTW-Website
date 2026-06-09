# deploy.ps1 — push the site to your Hetzner server
# Usage: .\deploy.ps1 -Server 1.2.3.4 -User root -RemotePath /var/www/btw

param(
  [Parameter(Mandatory)][string]$Server,
  [string]$User       = "root",
  [string]$RemotePath = "/var/www/btw"
)

$src = "$PSScriptRoot\"
$dest = "${User}@${Server}:${RemotePath}"

Write-Host "Deploying to $dest ..." -ForegroundColor Cyan

# rsync is the cleanest option; falls back to scp if rsync isn't available
if (Get-Command rsync -ErrorAction SilentlyContinue) {
  rsync -avz --delete --exclude "deploy.ps1" --exclude ".git" "$src" "$dest"
} else {
  # Ensure remote directory exists
  ssh "${User}@${Server}" "mkdir -p ${RemotePath}"
  scp -r "$src*" "$dest"
}

Write-Host "Done! Visit http://$Server to see your site." -ForegroundColor Green
