/**
 * 基础路由
 * @type { *[] }
 */

const constantRouterMap = [
  { path: '/', redirect: '/dashboard' },
  { path: '/dashboard', name: 'Dashboard', meta: { title: '概览' }, component: () => import('@/views/dashboard/Index.vue') },
  { path: '/playground', name: 'Playground', meta: { title: '试验台' }, component: () => import('@/views/playground/Index.vue') },
  { path: '/events', name: 'Events', meta: { title: '日志' }, component: () => import('@/views/events/Index.vue') },
  { path: '/rules', name: 'Rules', meta: { title: '规则' }, component: () => import('@/views/rules/Index.vue') },
  { path: '/extension', name: 'Extension', meta: { title: '浏览器扩展' }, component: () => import('@/views/extension/Index.vue') },
  { path: '/skill', name: 'Skill', meta: { title: '编程助手' }, component: () => import('@/views/skill/Index.vue') },
]

export default constantRouterMap
