// 挂载探针：不读模型、不花额度，只回答两件事 ——
//   ① 工具真的注册进 ctx.tools 了吗？
//   ② 两段引导真的落在最终系统提示里了吗？
// 工具的注册发生在 apply 之后的阶段，所以这里轮询等待，拿到结果就立即 exit，
// 不给 headless runner 真的去调模型的机会。
export const name = 'lmmarr-probe'

export function apply(ctx) {
  ctx.inject(['tools', 'systemPrompt'], (scoped) => {
    const deadline = Date.now() + 30000
    let attempt = 0
    const tick = async () => {
      attempt++
      let schemas = null
      try {
        schemas = scoped.tools.schemas() || []
      } catch (e) {
        console.log('[PROBE] schemas() threw: ' + (e && e.message))
      }
      if (schemas && schemas.length > 0) {
        await report(scoped, schemas, attempt)
        return
      }
      if (Date.now() > deadline) {
        console.log('[PROBE] gave up after ' + attempt + ' polls, schemas stayed empty')
        await report(scoped, schemas || [], attempt)
        return
      }
      setTimeout(tick, 200)
    }
    setTimeout(tick, 100)
  })
}

async function report(ctx, schemas, attempt) {
  let exitCode = 0
  try {
    const names = schemas.map((s) => s.name).filter(Boolean)
    const mine = names.filter((n) => n.startsWith('lmmarr_'))
    console.log('[PROBE] polls needed: ' + attempt)
    console.log('[PROBE] total tools: ' + names.length)
    console.log('[PROBE] lmmarr tools: ' + mine.length + ' ' + JSON.stringify(mine))
    if (mine.length !== 5) exitCode = 1
    console.log('[PROBE] all tool names: ' + JSON.stringify(names))

    const asm = await ctx.systemPrompt.assemble({})
    const sections = asm.sections || []
    const sectionNames = sections.map((s) => s.name)
    const hasProtocol = sectionNames.includes('lmmarr:protocol')
    const hasIndex = sectionNames.includes('lmmarr:index')
    console.log('[PROBE] has lmmarr:protocol: ' + hasProtocol)
    console.log('[PROBE] has lmmarr:index: ' + hasIndex)
    if (!hasProtocol || !hasIndex) exitCode = 1

    const idx = sections.findIndex((s) => s.name === 'lmmarr:protocol')
    if (idx >= 0) {
      console.log('[PROBE] protocol chars: ' + String(sections[idx].text || '').length)
      console.log('[PROBE] neighbour before: ' + JSON.stringify(sectionNames.slice(Math.max(0, idx - 1), idx)))
      console.log('[PROBE] neighbour after: ' + JSON.stringify(sectionNames.slice(idx + 2, idx + 3)))
    }

    const projection = sections.find((s) => s.name === 'lmmarr:index')
    if (projection) {
      const t = String(projection.text || '')
      console.log('[PROBE] projection chars: ' + t.length)
      console.log('[PROBE] projection mentions probe-alpha: ' + t.includes('probe-alpha'))
      console.log('[PROBE] projection has timestamp-like token: ' + /\b(20\d{2}-\d{2}-\d{2}|\d{2}:\d{2})\b/.test(t))
    }
  } catch (e) {
    console.log('[PROBE] ERROR ' + (e && e.message))
    exitCode = 1
  }
  console.log('[PROBE] RESULT ' + (exitCode === 0 ? 'PASS' : 'FAIL'))
  process.exit(exitCode)
}
