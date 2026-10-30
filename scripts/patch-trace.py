import io

s = open('src/renderer/app.ts', encoding='utf8').read()
old = """  async refresh(): Promise<void> {
    const seq = ++refreshSeq
    const [libs, list] = await Promise.all([
      api.libList().catch(() => this.libs),
      this.active ? api.entryList(this.listState as Record<string, unknown>) : Promise.resolve(undefined),
    ])
    mhTrace(`refresh#${seq} settle: active=${this.active?.name} total=${list?.total} (prev ${this.list?.total})`)"""
new = """  async refresh(): Promise<void> {
    const seq = ++refreshSeq
    mhTrace(`refresh#${seq} start: active=${this.active?.name}`)
    const p1 = api.libList().then(
      (v) => (mhTrace(`refresh#${seq} libList ok`), v),
      (e) => (mhTrace(`refresh#${seq} libList ERR ${String(e)}`), this.libs),
    )
    const p2 = this.active
      ? api.entryList(this.listState as Record<string, unknown>).then(
          (v) => (mhTrace(`refresh#${seq} entryList ok total=${(v as { total?: number })?.total}`), v),
          (e) => (mhTrace(`refresh#${seq} entryList ERR ${String(e)}`), Promise.reject(e)),
        )
      : Promise.resolve(undefined)
    const [libs, list] = await Promise.all([p1, p2])
    mhTrace(`refresh#${seq} settle: active=${this.active?.name} total=${list?.total} (prev ${this.list?.total})`)"""
assert old in s, 'refresh block drifted'
s = s.replace(old, new)
open('src/renderer/app.ts', 'w', encoding='utf8', newline='\n').write(s)
print('refresh instrumented')

s = open('src/renderer/views/memory-view.ts', encoding='utf8').read()
old2 = """    const entry = await api.entryCreate({ content: r.content, kind: r.kind, tags: r.tags, workspace: r.workspace || undefined })
    toast(`已保存记忆 ${entry.id.slice(0, 12)}…（${kindLabel(entry.kind)}）`)
    await app.refresh()
    app.select(entry.id)"""
new2 = """    const entry = await api.entryCreate({ content: r.content, kind: r.kind, tags: r.tags, workspace: r.workspace || undefined })
    ;(window as unknown as Record<string, unknown>).__mhTrace2__ = `${Date.now() % 100000} entryCreate ok ${entry.id.slice(0, 8)}`
    toast(`已保存记忆 ${entry.id.slice(0, 12)}…（${kindLabel(entry.kind)}）`)
    await app.refresh()
    ;(window as unknown as Record<string, unknown>).__mhTrace2__ = `${Date.now() % 100000} refresh done ${entry.id.slice(0, 8)}`
    app.select(entry.id)"""
assert old2 in s, 'runCreateEntry block drifted'
s = s.replace(old2, new2)
open('src/renderer/views/memory-view.ts', 'w', encoding='utf8', newline='\n').write(s)
print('create instrumented')

s = open('src/renderer/smoke-driver.ts', encoding='utf8').read()
old3 = "trace=${JSON.stringify(((window as unknown as Record<string, unknown>).__mhTrace__ as string[])?.slice(-6) ?? [])}`"
new3 = ("trace=${JSON.stringify(((window as unknown as Record<string, unknown>).__mhTrace__ as string[])?.slice(-8) ?? [])} "
        "t2=${(window as unknown as Record<string, unknown>).__mhTrace2__ ?? 'none'}`")
assert old3 in s, 'driver label drifted'
s = s.replace(old3, new3)
open('src/renderer/smoke-driver.ts', 'w', encoding='utf8', newline='\n').write(s)
print('driver instrumented')
