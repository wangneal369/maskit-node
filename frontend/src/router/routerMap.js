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
]

export default constantRouterMap
