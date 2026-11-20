<#
  Deploy DisasterShield AI to Google Cloud Run (serverless containers) with sign-in turned on.

  Usage (from the project root, in PowerShell):
    gcloud auth login
    python -m app.auth init            # run inside backend\ once: creates users.json (note the passwords!)
    .\deploy\cloudrun.ps1 -Project YOUR_GCP_PROJECT_ID

  Options:
    -Region       default asia-south1 (Mumbai, closest to Chennai)
    -Service      default disastershield
    -ScaleToZero  cheaper: no instance when idle. Live data (requests, audit log) is LOST whenever the instance restarts.

  What it does: enables the needed Google APIs, stores SHIELD_SECRET and SHIELD_USERS in Secret Manager (never in the image),
  builds the container with Cloud Build and deploys it. Nothing is changed in your project until you run it.
#>
param(
  [Parameter(Mandatory = $true)][string]$Project,
  [string]$Region = "asia-south1",
  [string]$Service = "disastershield",
  [switch]$ScaleToZero
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$users = Join-Path $root "backend\users.json"

if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) { throw "gcloud CLI not found. Install: https://cloud.google.com/sdk/docs/install" }
if (-not (Test-Path $users)) { throw "backend\users.json not found. Run:  cd backend; python -m app.auth init" }
$acct = gcloud auth list --filter=status:ACTIVE --format="value(account)"
if (-not $acct) { throw "Not signed in. Run: gcloud auth login" }

Write-Host "Project : $Project`nRegion  : $Region`nService : $Service`nAccount : $acct`nMode    : $(if ($ScaleToZero) {'scale-to-zero (state resets when idle)'} else {'always-on single instance'})"
$ans = Read-Host "Deploy to this project now? This creates billable resources. (yes/no)"
if ($ans -ne "yes") { Write-Host "Cancelled."; exit 0 }

gcloud config set project $Project | Out-Null
gcloud services enable run.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com artifactregistry.googleapis.com

function Set-Secret($name, $file) {
  gcloud secrets describe $name 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { gcloud secrets create $name --replication-policy=automatic | Out-Null }
  gcloud secrets versions add $name --data-file=$file | Out-Null
}

# signing key: created once, reused on later deploys so people stay signed in
gcloud secrets describe SHIELD_SECRET 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
  $tmp = New-TemporaryFile
  $bytes = New-Object byte[] 48; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  [IO.File]::WriteAllText($tmp, [Convert]::ToBase64String($bytes))
  Set-Secret "SHIELD_SECRET" $tmp; Remove-Item $tmp -Force
}
Set-Secret "SHIELD_USERS" $users

$num = gcloud projects describe $Project --format="value(projectNumber)"
$sa = "$num-compute@developer.gserviceaccount.com"
foreach ($s in "SHIELD_SECRET", "SHIELD_USERS") {
  gcloud secrets add-iam-policy-binding $s --member="serviceAccount:$sa" --role="roles/secretmanager.secretAccessor" | Out-Null
}

$scale = if ($ScaleToZero) { @("--min-instances", "0", "--max-instances", "1") } else { @("--min-instances", "1", "--max-instances", "1", "--no-cpu-throttling") }
# --allow-unauthenticated only opens the URL; the app itself enforces sign-in for Control Room and Rescue Officers.
gcloud run deploy $Service --source $root --region $Region --allow-unauthenticated `
  --timeout 3600 --memory 512Mi --concurrency 80 @scale `
  --set-env-vars "AUTH_MODE=on" --set-secrets "SHIELD_SECRET=SHIELD_SECRET:latest,SHIELD_USERS=SHIELD_USERS:latest"

$url = gcloud run services describe $Service --region $Region --format="value(status.url)"
Write-Host "`nDeployed.`n  Control Room (staff sign-in): $url/`n  Citizen help request:         $url/mobile/`n  Rescue officers:              $url/mobile/  -> 'Rescue Officer' tab"
