/** No runtime import: UserPlugins bundles in userData without repository aliases. */
export const examplePlugin = `// definePlugin is an identity helper; local definition avoids unresolved SDK imports.
const definePlugin = <T>(plugin: T): T => plugin
export default definePlugin({
  id: 'user.agent-glow', name: 'Agent Glow',
  activate(ctx: any) {
    ctx.properties.register({
      id: 'agent-glow', name: 'Agent Glow', description: 'Soft glow around visual content',
      icon: 'sparkles', category: 'Effects',
      params: [{ id: 'radius', label: 'Radius', type: 'number', unit: 'frameLen', default: 0.008, min: 0, max: 0.1 }],
      apply(v: Record<string, unknown>, ctx: any) {
        // PropertyOutput: filters, transforms and CSS; spatial lengths always use ctx.u.
        return { filter: [\`drop-shadow(0 0 \${ctx.u.len(Number(v.radius))} #82cbff)\`] }
      }
    })
  }
})`
export const pluginDocs = `A user plugin is a TypeScript default export {id,name,activate(ctx)}. definePlugin is an identity helper, defined locally below because the userData esbuild bundler cannot resolve @core aliases or a published Cascade SDK. No dependencies are needed.
activate(ctx) registers properties through ctx.properties.register. Registry entries are removed automatically on unload. Use unique ids (user.* for plugin; unique property id). activate runs in editor and export workers: avoid editor-only global state.
Property: {id,name,description,icon,category,params,apply(values,ctx)}. Param: {id,label,type,default,unit?,min?,max?,options?,animatable?}. Types and examples: registry_list. appliesTo optionally lists media type ids; stackable optionally permits multiple instances.
apply returns PropertyOutput: {transform?:string[],filter?:string[],backdropFilter?:string[],style?:Record<string,string>,contentStyle?:Record<string,string>,svgFilter?:string,extra?:Record<string,unknown>}. Never emit px lengths. ctx.u.x(fraction), ctx.u.y(fraction), ctx.u.len(fraction) emit stage-relative CSS. ctx.local is integer clip-local flicks. ctx.clip/media/project/mode/playing/elements are also available.
After plugin_write confirms reload, registry_list must contain agent-glow; add_property then set_param with frame fractions. Code runs with application privileges: only use trusted code.
\n${examplePlugin}`
