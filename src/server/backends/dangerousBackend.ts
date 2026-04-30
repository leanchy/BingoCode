// @generated stub from scan-missing-imports
// 该文件自动生成，对应 ant-internal 的 feature() gated 模块。
// 所有外部 build 的代码路径在 DCE 后都不会真的执行这里的代码，这只是
// bun build resolver 的占位符。

//@C:ID=M.FS.featureStub;K=M;V=1.0;P=Module definitions;D=Build;M=StubResolver;S=FeatureGates

//@C:ID=T.FS.ProxyHandlers;K=T;V=1.0;P=Define proxy handlers;D=Build;M=StubResolver;S=FeatureGates
const __target = function noop() {}
const __handler: ProxyHandler<any> = {
  get(_t, prop) {
    if (prop === '__esModule') return true
    if (prop === 'default') return new Proxy(__target, __handler)
    if (prop === Symbol.toPrimitive) return () => undefined
    if (prop === Symbol.iterator) return function* () {}
    if (prop === Symbol.asyncIterator) return async function* () {}
    if (prop === 'then') return undefined
    return new Proxy(__target, __handler)
  },
  ///@C:FS.ProxyApplyHandler
  apply() {
    return new Proxy(__target, __handler)
  },
  ///@C:FS.ProxyConstructHandler
  construct() {
    return new Proxy(__target, __handler)
  },
}

//@C:ID=D.FS.StubExports;K=D;V=1.0;P=Export stubs;D=Build;M=StubResolver;S=FeatureGates
const stub: any = new Proxy(__target, __handler)
export default stub
export const __stubMissing = true
// 兼容常见的命名导出 —— 没列在这里的也会通过 default Proxy 兜底
///@C:FS.MicrocompactExports
export const createCachedMCState = stub
export const isCachedMicrocompactEnabled = stub
export const isModelSupportedForCacheEditing = stub
export const getCachedMCConfig = stub
///@C:FS.ToolsExports
export const markToolsSentToAPI = stub
export const resetCachedMCState = stub
///@C:FS.SecurityExports
export const checkProtectedNamespace = stub
export const getCoordinatorUserContext = stub