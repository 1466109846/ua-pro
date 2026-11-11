# 第三方代码说明

本插件的 Profile 配置、设置服务、New API 账号与调度、部分界面和对应回归测试基于用户指定的 `magpie-codex-profile` 0.7.0，按 MIT 许可复用和适配。原始作者：Magpie Codex Profile contributors。许可证及原版权声明保留在 LICENSE。

参考插件仅用于只读研究和 MIT 代码适配。没有复制其中的 `.runtime`、`.release`、`.jez`、用户配置、密钥、抓包、截图或其他运行产物。

UA PRO 的初始 Codex / Claude 转换模板及部分兼容算法参考并适配 MIT 项目 `FischelChern/sub2api-magpie-plugin` 0.4.16（固定提交 `a22d079b241e630fc05d4ed2890580156c7828dd`）。其版权声明保留在 LICENSE；未复制品牌图片或运行数据。

Claude 的 Messages 参数模块与用户提供的 14 项请求头保留为独立模板。Codex 专用身份头只在选择相应 Codex / Responses 模板时处理，不默认加入 Claude 请求。
