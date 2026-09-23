// 视图注册表：新增面板 = 在模块里写 view.jsx + 在这里登记一行。
// App 的 tab 导航、hash 路由、懒加载全部由这张表驱动，改面板不用动壳。
import { lazy } from 'react';

export const VIEWS = [
  { id: 'link', title: '链接', component: lazy(() => import('../../modules/link/view.jsx')) },
  { id: 'doc', title: '文档与召回', component: lazy(() => import('../../modules/doc/view.jsx')) },
  { id: 'workflow', title: '工作流', component: lazy(() => import('../../modules/workflow/view.jsx')) },
  { id: 'hook-prompt', title: '提示词日志', component: lazy(() => import('../../modules/hook-prompt/view.jsx')) },
  { id: 'hook-skill', title: 'Skill 追踪', component: lazy(() => import('../../modules/hook-skill/view.jsx')) },
  { id: 'annotations', title: '文件批注', component: lazy(() => import('../../modules/annotations/view.jsx')) },
];