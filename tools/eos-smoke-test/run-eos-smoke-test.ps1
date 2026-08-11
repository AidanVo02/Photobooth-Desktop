param(
    [string]$OutputPath = (Join-Path $PSScriptRoot "eos60d-test.jpg"),
    [string]$EdsdkDirectory = "C:\Program Files (x86)\Canon\EOS Utility\EU2"
)

$ErrorActionPreference = "Stop"
$compiler = "C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe"
$source = Join-Path $PSScriptRoot "EosSmokeTest.cs"
$executable = Join-Path $PSScriptRoot "EosSmokeTest.exe"

if (-not (Test-Path -LiteralPath $compiler)) {
    throw "C# compiler was not found: $compiler"
}

& $compiler /nologo /target:exe /platform:x86 "/out:$executable" $source
if ($LASTEXITCODE -ne 0) {
    throw "Could not compile the EOS smoke test."
}

& $executable $OutputPath $EdsdkDirectory
exit $LASTEXITCODE
