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
# --exclude images/ so server-only uploads are never deleted
if (Get-Command rsync -ErrorAction SilentlyContinue) {
  rsync -avz --delete --exclude "deploy.ps1" --exclude ".git" --exclude "images/" "$src" "$dest"
} else {
  # Ensure remote directory exists
  ssh "${User}@${Server}" "mkdir -p ${RemotePath}"
  scp -r "$src*" "$dest"
}

# server.js runs from /var/www/btw-api — copy it there and restart
ssh "${User}@${Server}" "cp ${RemotePath}/server.js /var/www/btw-api/server.js && systemctl restart btw-api"

# Fix permissions so nginx (www-data) can read all files/dirs
ssh "${User}@${Server}" "find ${RemotePath} -type d -exec chmod 755 {} \; && find ${RemotePath} -type f -exec chmod 644 {} \;"

Write-Host "Done! Visit http://$Server to see your site." -ForegroundColor Green
