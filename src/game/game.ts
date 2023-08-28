import { EventEmitter } from "events"
import { Mutex } from 'async-mutex';
import { GameID, GameRuleName, IPlayer, PlayerID, PlayerMoveWarpper } from "./players/IPlayer"
import { PlayerBase } from "./players/PlayerBase";
import { GameRuleFactory } from "./gamerules/GameRuleFactory";
import { GameRuleBase, IGameRuleConstructor, GAME_SHALL_OVER, GAME_SHALL_BEGIN } from "./gamerules/GameRuleBase";
import { config } from "../configs/config";
import { All } from "src/utils";
import { Logger } from "@nestjs/common";
import { GameRuleProxy } from "./gamerules/gameruleProxy/GameRuleProxy";
import { Timely } from "src/utils/timely";
import { GameConfig } from "src/modules/game/entities/gameFacade.entity";

export type GameContext = {
  "players": Record<PlayerID, IPlayer>,
  "gameId"?: GameID,
  "gameRule"?: GameRuleBase,
  "gameover"?: boolean,
  "winner"?: PlayerID,
  "gameoverContext"?: any,
  "gameoverReason"?: string,
  "gameStartTime"?: number,
  "gameEndTime"?: number,
  "matchCtx": MatchContext
  [key: string]: any,
}

export type MatchContext = {
  [key: string]: any,
}

export class GameManager {
  static activeGames: Record<GameID, Game> = {}

  public static newGame(gameruleName: GameRuleName) {
    if (!GameRuleManager.gameRules.hasOwnProperty(gameruleName)) {
      throw new Error(`Game ${gameruleName} not found`)
    }

    const gameId = GameManager.newGameID()
    const gameRule = GameRuleManager.instantiate(gameruleName, gameId)
    const game = new Game(gameId, gameRule)
    // console.log(`Game ${gameId} created`)
    GameManager.activeGames[gameId] = game
    return game
  }

  static newGameID(): GameID {
    return "ac856d20-4e9c-409f-b1b3-d2d41a1df9a0"
    // return randomUUID()
  }

  static hasGame(gameId: GameID) { return GameManager.activeGames.hasOwnProperty(gameId) }

  static getGame(gameId: GameID) { return GameManager.activeGames[gameId] }
}

export class GameRuleManager {
  static gameRules: Record<string, IGameRuleConstructor | GameRuleFactory> = {}

  static get(gameRuleName: GameRuleName) {
    return GameRuleManager.gameRules[gameRuleName]
  }

  static instantiate(gameRuleName: GameRuleName, bindTo: GameID): GameRuleBase {
    const gameRule = GameRuleManager.get(gameRuleName)
    if (!gameRule) {
      throw new Error(`GameRule ${gameRuleName} not found`)
    }
    let gamerule = null

    if (gameRule instanceof GameRuleFactory) {
      gamerule = gameRule.newGameRule()
    } else {
      gamerule = new gameRule()
    }

    return gamerule
  }



  static registerGameRule(gameName: GameRuleName, gameRule: IGameRuleConstructor | GameRuleFactory) {
    GameRuleManager.gameRules[gameName] = gameRule
  }
}

export type GAMESTATE = 'organizing' | 'ready' | 'running' | 'gameover' | 'error'

const logger = new Logger('Game')
export class Game extends EventEmitter {
  players: Record<string, IPlayer> = {}
  uuid: string
  gameRule: GameRuleBase
  game_ctx: GameContext   // as a game context
  match_ctx: MatchContext = {} // to send to player 
  state: GAMESTATE = 'organizing'
  mutex = new Mutex();
  stopFlag = false
  stopReason?: string
  timely = new Timely.Timely()
  config: GameConfig = {
    timeouts: { //TODO make this configurable
      think: 100,
      prepare: {},
      run: 1000,
      all: 10000,
    }
  }

  constructor(id: string, gameRule: GameRuleBase) {
    super()
    this.uuid = id
    this.gameRule = gameRule

    this.game_ctx = {
      players: this.players,
      gameId: this.uuid,
      matchCtx: this.match_ctx,
    }

    this.gameRule.bind_ctx(this.game_ctx)
    gameRule.bind_parent(this)
    gameRule.on('ready', () => {
      this.emit('status-change')
    })
    // this is the onlt place to call this!

    this.on('status-change', async () => {
      const release = await this.mutex.acquire();
      try {
        if (this.state === 'organizing' && await this.Ready()) { // DO NOT SWAP THE ORDER OF THESE TWO CONDITIONS
          this.emit('game-ready', this)
          if (config.GAME_AUTO_BEGIN_WHEN_READY) {
            this.setState('running')
            this.begin()
          }
        }
      } finally {
        release();
      }
    })

    // TODO clean this
    this.timely.mark('think', this.config.timeouts.think)
      // .mark('prepare', this.config.timeouts.prepare)
      .mark('run', this.config.timeouts.run)
      .mark('all', this.config.timeouts.all)

  }

  async begin() {
    await this.gameRule.init_game(this.match_ctx)
    this.emit('game-begin', this)
    this.gamebeginCb && this.gamebeginCb(this) // TODO: clean this
    logger.debug(`game ${this.uuid} begin`)
    const { think, validate, accept, pre, post } = this.warpTimely()
    let turn = 0
    try {
      while (true) {
        if (turn > config.GAME_MAX_ROUND) {
          throw new Error(`Game ${this.uuid} turns exceed ${config.GAME_MAX_ROUND}`)
        }
        turn++
        const moves = []
        for (const playerId in this.players) {

          const { moveWarpper, move } = await think(playerId); // TODO: make validation, and do not use magic string

          await validate(moveWarpper, move);

          await accept(moves, move, moveWarpper);

          // TODO refactor this
          if (this.stopFlag) {
            throw new GameAbortException(this.stopReason)
          }

          if (await post(this.match_ctx, moveWarpper) === GAME_SHALL_OVER) {
            throw new GameOverException()
          }
        }
      }
    } catch (e) {
      if (e instanceof GameOverException) {
        // this is normal
        throw e
      } if (e instanceof GameAbortException) {
        logger.debug(`game ${this.uuid} aborted: ${e.message}`)
        throw e
      } else {
        throw e
      }
    } finally {
      // close all player
      for (const player of Object.values(this.players)) {
        (player as PlayerBase).onGameover(this.game_ctx)
      }

      this.setState('gameover')
      this.emit('gameover', this.game_ctx)
      this.gameoverCb && this.gameoverCb(this.game_ctx)
      logger.debug(`game ${this.uuid} over`)
    }
  }

  private warpTimely(): { think: any; validate: any; accept: any; pre: any; post: any; } {
    return this.timely.emitters({
      think: this.requireMove,
      validate: this.validateMove,
      accept: this.acceptMove,
      pre: this.gameRule.validate_game_pre_requirements,
      post: this.gameRule.validate_move_post_requirements
    });
  }

  private async acceptMove(moves: any[], move: any, moveWarpper: PlayerMoveWarpper) {
    moves.push(move);

    await this.gameRule.accept_move(this.match_ctx, moveWarpper);
  }

  private async validateMove(moveWarpper: PlayerMoveWarpper, move: any) {
    if (!await this.gameRule.validate_move(this.match_ctx, moveWarpper)) {
      throw new Error(`Game ${this.uuid} invalid move ${JSON.stringify(move)}`);
    }
  }

  private async requireMove(playerId: string) {
    const player = this.players[playerId]; //TODO: clean this
    const moveWarpper = (await player.move(this.match_ctx)); // TODO: make validation, and do not use magic string
    this.emit('player-move', this.uuid, player.uuid);
    const move = moveWarpper['move']; // TODO: make validation, and do not use magic string
    return { moveWarpper, move };
  }

  registerPlayer(gamer: PlayerBase) {
    this.players[gamer.uuid] = gamer
    // console.log(`player ${gamer.uuid} registered and waiting`)
    this.emit('player-registered', gamer)
    this.emit('status-change')
    gamer.on('status-change', (status: string) => {
      this.emit('status-change')
      this.emit('player-status-change', gamer, status)
    })
  }

  toString() {
    return JSON.stringify(this.brief())
  }

  brief() {
    return {
      'uuid': this.uuid,
      'players': Object.keys(this.players),
      'gameRule': this.gameRule
    }
  }

  setState(state: GAMESTATE) {
    this.state = state
    this.emit('state-change', state)
  }

  gameoverCb: (gameCtx: GameContext) => void

  whenGameOver() {
    return new Promise<GameContext>((resolve, reject) => {
      this.gameoverCb = resolve
    })
  }

  gamebeginCb: (game: Game) => void

  whenGameBegin() {
    return new Promise<Game>((resolve, reject) => {
      this.gamebeginCb = resolve
    })
  }

  public async Ready(): Promise<boolean> {
    return await this.gameRule.isReady()
      && All(Object.values(this.players), player => player.ready)
      && await this.gameRule.validate_game_pre_requirements(this.game_ctx) === GAME_SHALL_BEGIN
  }
}

class GameOverException extends Error {
  constructor() {
    super()
    this.name = "GameOverException"
  }
}

class GameAbortException extends Error {
  constructor(reason: string) {
    super()
    this.name = "GameAbortException"
    this.message = reason
  }
}

export interface GamerConstructor {
  new(uuid: string): IPlayer
}
