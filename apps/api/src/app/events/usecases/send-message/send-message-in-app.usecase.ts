import { Injectable } from '@nestjs/common';
import {
  MessageRepository,
  NotificationStepEntity,
  NotificationRepository,
  SubscriberRepository,
  SubscriberEntity,
  MessageEntity,
  IEmailBlock,
} from '@novu/dal';
import {
  ChannelTypeEnum,
  LogCodeEnum,
  LogStatusEnum,
  IMessageButton,
  ExecutionDetailsSourceEnum,
  ExecutionDetailsStatusEnum,
  InAppProviderIdEnum,
  StepTypeEnum,
} from '@novu/shared';
import * as Sentry from '@sentry/node';
import { CreateLog } from '../../../logs/usecases/create-log/create-log.usecase';
import { CreateLogCommand } from '../../../logs/usecases/create-log/create-log.command';
import { QueueService } from '../../../shared/services/queue';
import { SendMessageCommand } from './send-message.command';
import { SendMessageType } from './send-message-type.usecase';
import { CompileTemplate } from '../../../content-templates/usecases/compile-template/compile-template.usecase';
import { CompileTemplateCommand } from '../../../content-templates/usecases/compile-template/compile-template.command';
import { CreateExecutionDetails } from '../../../execution-details/usecases/create-execution-details/create-execution-details.usecase';
import {
  CreateExecutionDetailsCommand,
  DetailEnum,
} from '../../../execution-details/usecases/create-execution-details/create-execution-details.command';

@Injectable()
export class SendMessageInApp extends SendMessageType {
  constructor(
    private notificationRepository: NotificationRepository,
    protected messageRepository: MessageRepository,
    private queueService: QueueService,
    protected createLogUsecase: CreateLog,
    protected createExecutionDetails: CreateExecutionDetails,
    private subscriberRepository: SubscriberRepository,
    private compileTemplate: CompileTemplate
  ) {
    super(messageRepository, createLogUsecase, createExecutionDetails);
  }

  public async execute(command: SendMessageCommand) {
    Sentry.addBreadcrumb({
      message: 'Sending In App',
    });
    const notification = await this.notificationRepository.findById(command.notificationId);
    const subscriber: SubscriberEntity = await this.subscriberRepository.findOne({
      _environmentId: command.environmentId,
      _id: command.subscriberId,
    });
    const inAppChannel: NotificationStepEntity = command.step;
    let content = '';

    try {
      content = await this.compileInAppTemplate(inAppChannel.template.content, command.payload, subscriber, command);
    } catch (e) {
      await this.createExecutionDetails.execute(
        CreateExecutionDetailsCommand.create({
          ...CreateExecutionDetailsCommand.getDetailsFromJob(command.job),
          detail: DetailEnum.MESSAGE_CONTENT_NOT_GENERATED,
          source: ExecutionDetailsSourceEnum.INTERNAL,
          status: ExecutionDetailsStatusEnum.FAILED,
          isTest: false,
          isRetry: false,
          raw: JSON.stringify({
            subscriber,
            step: {
              digest: !!command.events.length,
              events: command.events,
              total_count: command.events.length,
            },
            ...command.payload,
          }),
        })
      );

      return;
    }

    if (inAppChannel.template.cta?.data?.url) {
      inAppChannel.template.cta.data.url = await this.compileInAppTemplate(
        inAppChannel.template.cta?.data?.url,
        command.payload,
        subscriber,
        command
      );
    }

    if (inAppChannel.template.cta?.action?.buttons) {
      const ctaButtons: IMessageButton[] = [];

      for (const action of inAppChannel.template.cta.action.buttons) {
        const buttonContent = await this.compileInAppTemplate(action.content, command.payload, subscriber, command);
        ctaButtons.push({ type: action.type, content: buttonContent });
      }

      inAppChannel.template.cta.action.buttons = ctaButtons;
    }

    const messagePayload = Object.assign({}, command.payload);
    delete messagePayload.attachments;

    const oldMessage = await this.messageRepository.findOne({
      _notificationId: notification._id,
      _environmentId: command.environmentId,
      _organizationId: command.organizationId,
      _subscriberId: command.subscriberId,
      _templateId: notification._templateId,
      _messageTemplateId: inAppChannel.template._id,
      channel: ChannelTypeEnum.IN_APP,
      transactionId: command.transactionId,
      content,
      providerId: 'novu',
      payload: messagePayload,
      _feedId: inAppChannel.template._feedId,
    });

    let message: MessageEntity;

    if (!oldMessage) {
      message = await this.messageRepository.create({
        _notificationId: notification._id,
        _environmentId: command.environmentId,
        _organizationId: command.organizationId,
        _subscriberId: command.subscriberId,
        _templateId: notification._templateId,
        _messageTemplateId: inAppChannel.template._id,
        channel: ChannelTypeEnum.IN_APP,
        cta: inAppChannel.template.cta,
        _feedId: inAppChannel.template._feedId,
        transactionId: command.transactionId,
        content,
        payload: messagePayload,
        templateIdentifier: command.identifier,
        _jobId: command.jobId,
      });
    }

    if (oldMessage) {
      await this.messageRepository.update(
        {
          _id: oldMessage._id,
        },
        {
          $set: {
            seen: false,
            cta: inAppChannel.template.cta,
            content,
            payload: messagePayload,
            createdAt: new Date(),
          },
        }
      );
      message = await this.messageRepository.findById(oldMessage._id);
    }

    const unseenCount = await this.messageRepository.getCount(
      command.environmentId,
      command.subscriberId,
      ChannelTypeEnum.IN_APP,
      { seen: false }
    );

    const unreadCount = await this.messageRepository.getCount(
      command.environmentId,
      command.subscriberId,
      ChannelTypeEnum.IN_APP,
      { read: false }
    );

    await this.createExecutionDetails.execute(
      CreateExecutionDetailsCommand.create({
        ...CreateExecutionDetailsCommand.getDetailsFromJob(command.job),
        messageId: message._id,
        providerId: InAppProviderIdEnum.Novu,
        detail: DetailEnum.MESSAGE_CREATED,
        source: ExecutionDetailsSourceEnum.INTERNAL,
        status: ExecutionDetailsStatusEnum.PENDING,
        isTest: false,
        isRetry: false,
      })
    );

    await this.createLogUsecase.execute(
      CreateLogCommand.create({
        transactionId: command.transactionId,
        status: LogStatusEnum.SUCCESS,
        environmentId: command.environmentId,
        organizationId: command.organizationId,
        notificationId: notification._id,
        messageId: message._id,
        text: 'In App message created',
        userId: command.userId,
        subscriberId: command.subscriberId,
        code: LogCodeEnum.IN_APP_MESSAGE_CREATED,
        templateId: notification._templateId,
        raw: {
          payload: command.payload,
          triggerIdentifier: command.identifier,
        },
      })
    );
    console.log(`Before event trigger: ${JSON.stringify({
      event: 'unseen_count_changed',
      userId: command.subscriberId,
      payload: {
        unseenCount,
      },
    })}`)
    await this.queueService.wsSocketQueue.add({
      event: 'unseen_count_changed',
      userId: command.subscriberId,
      payload: {
        unseenCount,
      },
    });
    console.log(`Event triggered: ${JSON.stringify({
      event: 'unseen_count_changed',
      userId: command.subscriberId,
      payload: {
        unseenCount,
      },
    })}`)
    console.log(`Before event trigger: ${JSON.stringify({
      event: 'unseen_count_changed',
      userId: command.subscriberId,
      payload: {
        unseenCount,
      },
    })}`)
    await this.queueService.wsSocketQueue.add({
      event: 'unread_count_changed',
      userId: command.subscriberId,
      payload: {
        unreadCount,
      },
    });
    console.log(`Event triggered: ${JSON.stringify({
      event: 'unseen_count_changed',
      userId: command.subscriberId,
      payload: {
        unseenCount,
      },
    })}`)

    await this.createExecutionDetails.execute(
      CreateExecutionDetailsCommand.create({
        ...CreateExecutionDetailsCommand.getDetailsFromJob(command.job),
        messageId: message._id,
        providerId: InAppProviderIdEnum.Novu,
        detail: DetailEnum.MESSAGE_SENT,
        source: ExecutionDetailsSourceEnum.INTERNAL,
        status: ExecutionDetailsStatusEnum.SUCCESS,
        isTest: false,
        isRetry: false,
      })
    );
  }

  private async compileInAppTemplate(
    content: string | IEmailBlock[],
    payload: any,
    subscriber: SubscriberEntity,
    command: SendMessageCommand
  ): Promise<string> {
    return await this.compileTemplate.execute(
      CompileTemplateCommand.create({
        templateId: 'custom',
        customTemplate: content as string,
        data: {
          subscriber,
          step: {
            digest: !!command.events.length,
            events: command.events,
            total_count: command.events.length,
          },
          ...payload,
        },
      })
    );
  }
}
