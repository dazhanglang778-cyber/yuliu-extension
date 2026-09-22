$ErrorActionPreference = "Stop"

$testFiles = Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot "tests") -Filter "*.test.js" |
  Sort-Object Name |
  ForEach-Object { $_.FullName }

if (-not $testFiles) {
  throw "未找到 tests/*.test.js"
}

& node --test $testFiles
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
