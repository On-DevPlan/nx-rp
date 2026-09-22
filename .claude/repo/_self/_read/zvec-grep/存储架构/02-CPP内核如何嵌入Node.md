# @zvec/zvec 如何把 C++ 内核嵌入 Node.js

> **仓库**: `.claude/repo/zvec-node/`（Node binding 层）+ `.claude/repo/zvec/`（C++ 内核本体）
> **类型**: 阅读分析（现状盘点，不含改进建议）
> **核心问题**: `npm install @zvec/zvec` 装的到底是什么？C++ 代码怎么跑到 Node 进程里的？

## 一句话结论

`@zvec/zvec` 是一个 **Node.js N-API 原生插件（native addon）**：C++ 内核（alibaba/zvec）编译成 `.node` 二进制文件（本质是动态链接库），通过 **node-addon-api** 暴露 JS 可调用的函数；**内核以静态库（`.a`/.`lib`）形式链接进这个 `.node` 文件**——运行时没有任何独立进程或服务，vector 引擎直接活在你的 Node 进程里。分发采用 **平台子包预编译**（8 个 `@zvec/bindings-*` optionalDependencies）+ 源码编译兜底。

## 1. 三层结构

```
你的 JS（zg 的 storage/zvec.ts）
    │  require("@zvec/zvec")
    ▼
JS 包装层  @zvec/zvec（zvec-node 仓库，纯 JS）
    │  src/index.js → require(prebuilt .node 二进制)
    ▼
N-API 绑定层  zvec_node_binding.node（C++，node-addon-api）
    │  src/binding/*.cc — 直接调用 zvec:: 命名空间
    ▼
C++ 内核  libzvec_ailego.a + libzvec_core.a + libzvec_turbo.a
    （alibaba/zvec 仓库，静态链接进 .node）
```

## 2. 绑定层：JS ↔ C++ 的桥

**入口注册**（`zvec-node/src/binding/addon.cc:26-40`）：

```cpp
// 来源: zvec-node/src/binding/addon.cc:26-40
Napi::Object Init(Napi::Env env, Napi::Object exports) {
  auto *ctors = new AddonConstructors{};
  exports = binding::InitTypes(env, exports);
  exports = binding::InitConfig(env, exports);
  exports = binding::CollectionSchema::Init(env, exports, ctors);
  exports = binding::DocIterator::Init(env, exports, ctors);
  exports = binding::Collection::Init(env, exports, ctors);
  env.SetInstanceData(ctors);
  return exports;
}
NODE_API_MODULE(zvec_node_binding, Init)
```

**内核调用是直接的 C++ 方法调用**——binding 头文件里持有内核对象指针（`zvec-node/src/binding/collection.h:5,93-94`）：

```cpp
#include <zvec/db/collection.h>          // 直接 include 内核头
zvec::Collection::Ptr collection_{nullptr};
zvec::CollectionSchema::Ptr schema_{nullptr};
```

`collection.cc:15-20` 的 `CreateAndOpenCollection` 把 JS 的 `(path, schema)` 参数解包成 `std::string` / `CollectionSchema::Ptr`，转手调 `zvec::Collection`——没有序列化、没有 IPC、没有 socket，就是进程内的 C++ 函数调用。异步操作（`async_workers.cc`）走 N-API 的 AsyncWorker 线程池，不阻塞事件循环。

## 3. 编译：内核以静态库链进 .node

`zvec-node/CMakeLists.txt` 把 alibaba/zvec 作为 **git submodule**（`zvec-node/.gitmodules:1-3`，vendored 在 `src/zvec/`）做外部构建，然后**静态链接**（`:53-65`）：

```cmake
# Windows
set(ZVEC_DB_LIB ${ZVEC_LIB_DIR}/zvec.lib)
    ${ZVEC_LIB_DIR}/zvec_ailego.lib
    ${ZVEC_LIB_DIR}/zvec_core.lib
    ${ZVEC_LIB_DIR}/zvec_turbo.lib
# Linux/macOS
set(ZVEC_DB_LIB ${ZVEC_LIB_DIR}/libzvec.a)
    ${ZVEC_LIB_DIR}/libzvec_ailego.a
    ${ZVEC_LIB_DIR}/libzvec_core.a
    ${ZVEC_LIB_DIR}/libzvec_turbo.a
```

三个静态库对应内核仓库的三个模块（`zvec/src/`）：

- `ailego` — 基础框架层
- `core` — 数据库核心：`core/algorithm/`（**hnsw、ivf、diskann、vamana、flat_sparse、hnsw_rabitq…** 全部向量索引算法，`zvec/src/core/algorithm/` 目录实测）+ `db/`（collection、查询、SQL 引擎、reranker）+ `db/sqlengine/`（**ANTLR 生成的 SQL 解析器**，过滤表达式就是这么来的）
- `turbo` — SIMD 加速调度

## 4. 分发：平台子包 + 预编译优先

**用户 `npm install @zvec/zvec` 时发生什么**（`zvec-node/package.json:59-68` + `scripts/install.js:8-50`）：

1. 主包带 8 个 `optionalDependencies`：`@zvec/bindings-{darwin,linux,win32}-{arm64,x64}`（Linux 再分 glibc/musl，`detect-libc` 运行时探测）
2. npm 只装当前平台匹配的那个子包（每个子包里是一份预编译好的 `zvec_node_binding.node`）
3. `scripts/install.js` 依次尝试：主包 tarball 内捆绑的二进制 → 平台子包里的二进制 → 都没有且是源码 checkout 时提示本地编译（cmake-js），否则报错退出

**加载**（`zvec-node/src/index.js:12-19`）：`require()` 那个 `.node` 文件——Node 把它当作动态链接库 dlopen 进当前进程，JS 侧拿到的就是 Init 注册的那组函数。

**jieba 词典**（`package.json:44-45`）作为数据文件随主包分发（`jieba_dict/jieba.dict.utf8` 等），内核 C API 有 `zvec_config_data_set_jieba_dict_dir`（`zvec/src/binding/c/c_api.cc:677-684`）指定词典路径——中文分词是内核 thirdparty 的 **cppjieba**（`zvec/thirdparty/` 实测：cppjieba、rocksdb、antlr、snowball、RaBitQ-Library、lz4…）。

## 5. 「嵌入」意味着什么（运行时形态）

| 维度   | zvec（本方案）                             | 独立服务型向量库       |
| ------ | ------------------------------------------ | ---------------------- |
| 进程   | 同一个 Node 进程内                         | 独立进程 + 网络端口    |
| 调用   | C++ 函数调用（纳秒~微秒级）                | HTTP/gRPC 往返         |
| 部署   | `npm install` 即完成                     | 装服务、管端口、配集群 |
| 崩溃域 | 引擎崩 = Node 进程崩                       | 引擎崩，应用还在       |
| 并发   | 单进程独占写（zg 靠文件锁协调 CLI/daemon） | 服务端管理多客户端     |

这正是 zg 敢把「打开失败重试 + LOCK 文件探测 + readOnly 模式」做在 JS 层的原因（见前一篇 `01-存储设施与索引布局.md` 第 5 节）——内核是进程内的库，进程间协调只能靠文件锁，zg 在 `zvec.ts:828-902` 自己实现了这套。

## 6. 与 Node 内置方案（node:sqlite）的结构对比（事实层面）

两者是同一种「嵌入」哲学的不同实现：

|          | node:sqlite                | @zvec/zvec                           |
| -------- | -------------------------- | ------------------------------------ |
| 内核     | SQLite（C）                | zvec（C++）                          |
| 嵌入方式 | Node 官方内置编译          | npm 平台子包预编译 .node             |
| 对外形态 | `DatabaseSync` JS 类     | `ZVecCollection` JS 类             |
| 索引能力 | B-tree + FTS5              | HNSW/IVF/DiskANN + FTS(jieba) + 倒排 |
| 安装面   | 零（Node 自带，需 ≥22.5） | 每平台一个原生二进制子包             |

## 源码索引

| 主题                        | 位置                                                                               |
| --------------------------- | ---------------------------------------------------------------------------------- |
| NAPI 模块注册               | `zvec-node/src/binding/addon.cc:26-40`                                           |
| binding 持有内核指针        | `zvec-node/src/binding/collection.h:5,93-94`                                     |
| JS→C++ 参数解包            | `zvec-node/src/binding/collection.cc:15-20`                                      |
| 静态链接三库                | `zvec-node/CMakeLists.txt:53-65`                                                 |
| submodule 引用              | `zvec-node/.gitmodules:1-3`                                                      |
| 平台子包与预编译策略        | `zvec-node/package.json:59-68`、`scripts/install.js:8-50`、`src/prebuilt.js` |
| `.node` 加载              | `zvec-node/src/index.js:12-19`                                                   |
| 向量算法全家桶              | `zvec/src/core/algorithm/`（hnsw/ivf/diskann/vamana/…）                         |
| SQL 引擎（filter 语法来源） | `zvec/src/db/sqlengine/`（ANTLR）                                                |
| jieba 分词内核侧            | `zvec/thirdparty/cppjieba`、`zvec/src/binding/c/c_api.cc:677-684`              |
