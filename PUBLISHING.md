# GitHub 发布清单

这个目录是独立公开仓库的根目录，不应直接把上层私人项目作为仓库上传。当前没有执行 GitHub 上传。

维护者发布前：

1. 确认以这个目录为仓库根；检查 `git status` 和待提交文件清单，确认 `state/`、`artifacts/`、日志、截图、凭据与私人资料不在提交中。
2. 再次检查源码和提交历史中的密钥、Cookie、个人路径、真实采集链接与第三方许可。若发现敏感信息，先在本地处理，不要通过“之后删除提交”来补救。
3. 运行 `npm run setup`、`npm test`、`npm run test:ui-regressions` 与 `npm run test:collection-recovery`。GitHub Actions 通过后仍要明确区分离线测试与真实平台验收。
   Windows x64 便携版使用 PowerShell 7 执行 `pwsh -NoProfile -File scripts/build-windows-portable.ps1`，校验压缩包 SHA-256，实际解压并在干净目录中启动；发布该 ZIP 及校验值，不能拿 GitHub 自动生成的源码 ZIP 充当便携版。
4. 检查 README 的功能边界、MIT 版权署名、扩展权限和安全说明，再决定公开范围与仓库名称。
5. 仅在所有者明确要求本次发布时创建仓库、提交与推送；优先使用已有的本机 GitHub 登录。若账号尚未授权，登录步骤需由所有者完成。

公开后应在 GitHub 仓库设置中启用私密漏洞报告。首次 Release 应标注为预览版，写明真实平台采集可靠性仍未验收。
