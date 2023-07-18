import { JailedCommandExecutor, SystemCommandExecutor } from "../executor/commandExecutor"
import { IModule } from "../modules/IModule"
import { recursive_render_obj, render } from "../utils"
import * as fs from 'fs'

export class BKPileline {

  config: object
  context: object = {}

  constructor(config_path: string | object) {
    if (typeof config_path === 'object') {
      this.config = config_path
    } else {
      this.config = JSON.parse(fs.readFileSync(config_path, 'utf8'))
    }
    this.context = this.config['constants']
  }

  async run() {
    const jobs = this.config['jobs']
    const onSuccess = this.config['onSuccess'] ?? 'next'
    const onFailure = this.config['onFailure'] ?? 'stop'
    for (const job of jobs) {
      const executor = new JobExecutor(job)
      executor.inject(this.context)
      try {
        console.log(`Running job ${job.name}`)
        console.log(await executor.run())
        this.job_completion_strategy[onSuccess]()
      } catch (err) {
        console.log(`when executing job ${job.name}`, err)
        this.job_completion_strategy[onFailure](err.message)
      }
    }
  }

  job_completion_strategy = {
    'next': () => { },
    'stop': (msg) => { throw new Error(msg) },
  }

  static registerModule(module_name, module) {
    JobExecutor.register_module(module_name, module)
  }

  addCtx(dict: { [x: string]: any; }) {
    this.context = Object.assign(this.context, dict)
  }
}

export class JobExecutor {

  context: object
  job: object

  constructor(job) {
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

  async run_command(command, args) {
    if (this.job.hasOwnProperty('jail')) {
      const jailConfig = this.job['jail']
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

  async run_module(module, _with, ctx = undefined) {
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

  public static register_module(module_name, module) {
    JobExecutor.modules[module_name] = module
  }
}