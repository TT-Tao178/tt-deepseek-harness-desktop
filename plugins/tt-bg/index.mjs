// tt-bg Node half：极简。背景显示层完全运行在浏览器 half（client.js）——
// 背景层注入、页面级背景容器透明化、__ttBg 均由 client 提供。
// 契约：官方 bundle 插件（dsh.bundle.patch + dsh.client），与 gal-view 同构。
export const name = 'tt-bg'

export const inject = []

export function apply() {
  // 无宿主侧行为：client half 自行注入背景层。
}
