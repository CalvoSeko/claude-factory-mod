import { expect, mock } from 'claude-code/testing'
import { test } from './kit'
import type { RenderElement } from 'claude-code'

const BAND = {
  plugin: 'agent-graph',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 100, scroll: { offset: 0, bodyRows: 4 }, view: {} },
} as const

test('the band button toggles the pane and keeps the other band', async ($, on) => {
  mock.store(on)
  // Opening the pane on a graph already open reads its instructions again, at most every 2 s.
  mock.clock(on)
  const opened: string[] = []
  const closed: string[] = []
  on('ui.open', (_$, e) => { opened.push(e.id); return { value: { isPlaced: true } } as never })
  on('ui.close', (_$, e) => { closed.push(e.id); return { value: undefined } as never })
  on('fs.write', () => ({ value: undefined }) as never)
  on('env.get', () => ({ value: undefined }) as never)
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, 'other band') as RenderElement
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ text: /other band/ }), `${surface}: other band`).toBeDefined()
    const drawn = JSON.stringify(await ui.drawn())
    expect(drawn.indexOf('other band'), `${surface}: the other band comes first`).toBeGreaterThan(-1)
    expect(drawn.indexOf('other band')).toBeLessThan(drawn.indexOf('agent-graph'))
    expect((await ui.find({ key: 'agent-graph' }))?.props.label).toBe('⧉ Agent Graph')
    await ui.press({ key: 'agent-graph' })
    expect((await ui.find({ key: 'agent-graph' }))?.props.label).toBe('Close graph')
    await ui.press({ key: 'agent-graph' })
    expect((await ui.find({ key: 'agent-graph' }))?.props.label).toBe('⧉ Agent Graph')
    await ui.unmount()
  }
  expect(opened).toEqual(['agent-graph', 'agent-graph'])
  expect(closed).toEqual(['agent-graph', 'agent-graph'])
})

test('the band button steps aside for a survey', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, 'survey') as RenderElement
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, hasSurvey: true } })
  expect(await ui.find({ key: 'agent-graph' })).toBeUndefined()
  expect(await ui.find({ text: /survey/ })).toBeDefined()
})
