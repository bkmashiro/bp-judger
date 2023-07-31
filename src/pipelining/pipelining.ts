import { JailedCommandExecutor, SystemCommandExecutor } from "./executors/commandExecutor"
import { IModule } from "./modules/IModule"
import { recursive_render_obj, render } from "../utils"
import * as fs from 'fs'
import * as path from 'path'
import { config } from "../configs/config"
import { Logger } from "@nestjs/common"

export class BKPileline {
  config: object
  context: object = {}
  cache: object = {}

  constructor(config_path: string | object) {
    if (typeof config_path === 'object') {
      this.config = config_path
    } else {
      this.config = JSON.parse(fs.readFileSync(config_path, 'utf8'))
    }
    this.context = this.config['constants'] ?? {}
  }

  async run() {
    const jobs = this.config['jobs']
    const onSuccess = this.config['onSuccess'] ?? 'next'
    const onFailure = this.config['onFailure'] ?? 'stop'
    for (const job of jobs) {
      if(!job.hasOwnProperty('name')) {
        job.name = '<Anonymous>'
      }
      const executor = new JobExecutor(job)
      executor.inject(this.context)
      try {
        console.log(`Running job ${job.name}`)
        const ret = await executor.run()
        console.log(`Job ${job.name} finished returning ${ret}`)
        this.job_completion_strategy[onSuccess]()
        // bind the return value to context
        if (typeof ret === 'string') {
          this.context[job.name] = ret
        } else if (typeof ret === 'object') {
          for (const key in ret) {
            this.context[`${job.name}.${key}`] = ret[key]
          }
        }
      } catch (err) {
        console.log(`when executing job ${job.name}`, err)
        this.job_completion_strategy[onFailure](err.message)
      }
    }
  }

  job_completion_strategy = {
    'next': () => { },
    'stop': (msg: string) => { throw new Error(msg) },
  }

  static registerModule(module_name: string, module: IModule) {
    JobExecutor.register_module(module_name, module)
  }

  ctx(dict: { [x: string]: any; }) {
    Logger.log(`context is ${JSON.stringify(this.context)}`)
    Logger.log(`Injecting context ${JSON.stringify(dict)}`)

    this.context = Object.assign(this.context, dict)
    return this
  }

  public static fromConfig(config: object) {
    return new BKPileline(config)
  }

  static predefined(pipelineName: string) {
    return BKPileline.fromConfig(require_config(pipelineName))
  }
} 

export function require_procedure(procedure_name: string) : ProcedurePiece {
  const procedure_path = path.resolve(config.configs_path,`./procedures/${procedure_name}.json`)
  if (! fs.promises.access(procedure_path)) {
    throw new Error(`Procedure ${procedure_name} not found`)
  }
  return new ProcedurePiece(JSON.parse(fs.readFileSync(procedure_path, 'utf8')))
}

export function require_config(config_name: string) : object {
  const config_path = path.resolve(config.configs_path,`./predefined/${config_name}.json`)
  if (!fs.promises.access(config_path)) {
    throw new Error(`Config ${config_name} not found`)
  }
  return JSON.parse(fs.readFileSync(config_path, 'utf8'))
}

class ProcedurePiece {
  raw: object
  constructor(raw: object) {
    this.raw = raw
  }
  named(name:string) {
    this.raw['name'] = name
    return this
  }

  with(ctx:object) {
    this.raw['with'] = ctx
    return this
  }

  set(kv: object) {
    this.raw = Object.assign(this.raw, kv)
    return this
  }

  jail(jailConfig: object) {
    this.raw['jail'] = jailConfig
    return this
  }

  compile(ctx:object={}) {
    const jobs = recursive_render_obj(this.raw, ctx)
    return jobs
  }
}

export class JobExecutor {

  context: object
  job: object

  constructor(job: object) {
    this.job = job
    this.context = {}
  }

  async run() {
    if (this.job.hasOwnProperty('run')) {
      let command = render(this.job['run'], this.context)

      //spilt command into command and args
      const args = command.split(' ')
      command = args.shift()

      return this.run_command(command, args)
    } else if (this.job.hasOwnProperty('use')) {
      const module_name = this.job['use']
      const with_ = recursive_render_obj(this.job['with'], this.context)
      return this.run_module(module_name, with_, this.context)
    } else {
      throw new Error(`Unknown job type`)
    }
  }

  async run_command(command: string, args: string[]) {
    if (this.job.hasOwnProperty('jail')) {
      const jailConfig = recursive_render_obj(this.job['jail'], this.context)
      const executor = new JailedCommandExecutor(jailConfig)
      return executor.run(command, args)
    } else {
      const executor = new SystemCommandExecutor()
      return executor.run(command, args)
    }
  }

  static modules: {
    [x: string]: IModule;
  } = {}

  async run_module(module: string, _with: object, ctx = undefined) {
    if (JobExecutor.modules.hasOwnProperty(module)) {
      return JobExecutor.modules[module].run(_with, ctx)
    } else {
      throw new Error(`Module ${module} not found`)
    }
  }

  public get name(): string {
    return this.job['name']
  }

  public inject(ctx: { [x: string]: any; }) {
    this.context = ctx
  }

  public static register_module(module_name: string, module: IModule) {
    JobExecutor.modules[module_name] = module
  }
}