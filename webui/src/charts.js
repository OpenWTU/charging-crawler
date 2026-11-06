// echarts 按需注册入口。
// 只在分析页真正要画图时被 App.vue 动态 import，因此实时页（首屏）不会下载图表代码。
// 这里用静态的具名 import，Rollup 能继续 tree-shake 掉未用到的图表类型。
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { GridComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([LineChart, GridComponent, TooltipComponent, CanvasRenderer]);

export { echarts };
