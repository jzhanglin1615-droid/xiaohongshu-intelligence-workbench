param([ValidateSet('Protect', 'Unprotect')][string]$Action)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$entropy = [System.Text.Encoding]::UTF8.GetBytes('xhs-model-workbench-v1')
$inputValue = [Console]::In.ReadToEnd()
if ($Action -eq 'Protect') {
  $plain = [System.Text.Encoding]::UTF8.GetBytes($inputValue)
  $cipher = [System.Security.Cryptography.ProtectedData]::Protect($plain, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([Convert]::ToBase64String($cipher))
} else {
  $cipher = [Convert]::FromBase64String($inputValue.Trim())
  $plain = [System.Security.Cryptography.ProtectedData]::Unprotect($cipher, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($plain))
}
