# libtailscale 源码依赖说明

本目录采用 vendoring：将第三方源码及本项目的修改直接保存到主仓库中，**不是 Git submodule**，也不会在构建时自动拉取 libtailscale 的最新源码。

## 为什么采用这种方式

本项目对 libtailscale 的连接描述符与对端地址处理做了本地修改，详见 [LOCAL_CHANGES.md](LOCAL_CHANGES.md)。保存完整源码快照，可以让这些修改与主项目一起审查、发布和构建，避免子模块未初始化或引用到不含修改的版本。

克隆仓库或下载源码 ZIP 时会包含这份源码，无需执行 `git submodule update`。构建仍需要相应工具链，并可能下载 Go 模块依赖；源码随仓库保存不代表完全离线构建。

## 文件用途

- `source/`：用于构建的 libtailscale 源码快照，包含本地修改。
- [source.json](source.json)：上游地址、快照来源标识、Tailscale 版本与 Go 工具链版本。`revision` 是快照来源记录，不保证是上游仓库可检出的提交。
- [LOCAL_CHANGES.md](LOCAL_CHANGES.md)：本地修改及兼容性注意事项。
- [LICENSE](LICENSE)：第三方 BSD-3-Clause 许可证；分发时保留许可证和版权声明。

[构建脚本](../../scripts/build-libtailscale.cjs) 直接编译 `source/`，生成物写入 `.local/libtailscale-build/`。生成物可清理，本目录源码需要保留。

## 更新方式

更新时先核对上游来源和许可证，再合并源码变更并保留或重新适配本地修改。同步更新 `source.json` 和 `LOCAL_CHANGES.md`，重新构建并验证连接与对端地址处理。不要直接覆盖源码目录而丢失补丁，也不要混用不同版本的原生库产物。

如果未来需要多个项目共享这些修改，可以将修改后的源码维护在独立仓库，再改为 submodule；当前不采用这一方式。
