import { PlayerMove, PlayerMoveWarpper } from "src/pipelining/modules/playerModule/player";
import { GameContext, MatchContext } from "../game";
import { EventEmitter } from "events";

export interface IGameRule {
  validate_game_pre_requirements(ctx: GameContext):  Promise<boolean>
  validate_move_post_requirements(ctx: GameContext, move: PlayerMoveWarpper):  Promise<boolean>
  validate_move(ctx: GameContext, move: PlayerMoveWarpper):  Promise<boolean>
  accept_move(ctx: GameContext, move: PlayerMoveWarpper):  Promise<void>
  init_game(ctx: GameContext):  Promise<void>
}

export type IGameRuleConstructor = (new () => GameRuleBase);
export type GameRuleStatus = "ready" | "offline"

export abstract class GameRuleBase extends EventEmitter implements IGameRule {
  status: GameRuleStatus = "offline" 
  ctx: GameContext
  secret: { [key: string]: any } = {}

  abstract validate_game_pre_requirements(ctx: MatchContext): Promise<boolean>

  abstract validate_move_post_requirements(ctx: MatchContext, moveWarpper: PlayerMoveWarpper):  Promise<boolean>

  abstract validate_move(ctx: MatchContext, moveWarpper: PlayerMoveWarpper):  Promise<boolean>

  abstract accept_move(ctx: MatchContext, moveWarpper: PlayerMove):  Promise<void>

  /** @deprecated 
   * Never call this yourself
   * DO NOT REMOVE THIS METHOD */ 
  bind_ctx(gameContext: GameContext): void {
    this.ctx = gameContext
  }

  abstract init_game(ctx: MatchContext):  Promise<void>

  whenGameover = new Promise<GameContext>((resolve, reject) => {
    this.on('gameover', (gameContext: GameContext) => {
      resolve(gameContext.gameoverContext)
    })
  })

  validation_failed(ctx: GameContext, reason: string) {
    this.emit('validation_failed', ctx, reason)
  }

  winnerIs(winner: string) {
    this.ctx.winner = winner
    return this
  }

  gameover() {
    this.ctx.gameover = true
    this.emit('gameover', this.ctx)
    return this
  }

  public isReady(): Promise<boolean> {
    return Promise.resolve(true)
  }
}

export const GAME_SHALL_OVER = false
export const GAME_SHALL_CONTINUE = true
export const GAME_SHALL_BEGIN = true
export const GAME_SHALL_WAIT = false