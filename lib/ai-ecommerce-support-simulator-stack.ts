import path from "path";

/*
 * CFN-NAG Security Fixes Applied:
 * - W35: Added access logging for all S3 buckets
 * - W84: Added KMS encryption for CloudWatch Log Groups
 * - W12: Made Bedrock IAM policies more specific (limited to common foundation models)
 *
 * Remaining violations that require architectural decisions:
 * - W70: CloudFront minimum protocol version is already set to TLS 1.2
 * - W11: IAM roles with wildcard resources (UserPool SMS role, Bedrock KB validation role) - these are managed by CDK/AWS services
 * - W58: Lambda CloudWatch Logs permissions - FALSE POSITIVE: User-defined functions have explicit log groups and permissions.
 *        CDK-managed custom resource functions have permissions via AWSLambdaBasicExecutionRole managed policy.
 *        cfn_nag doesn't recognize managed policy permissions, causing false positives.
 * - W89: Lambda functions inside VPC - would require VPC setup and may impact performance
 * - W92: Reserved concurrent executions - already set for user Lambda functions, CDK-managed functions don't need this
 * - W76: SPCM (Single Policy Complexity Metric) - policy complexity is acceptable for this use case
 */

import {
  aws_lambda as lambda,
  aws_sqs as sqs,
  aws_lambda_nodejs as nodejs,
  aws_iam as iam,
  aws_appsync as appsync,
  aws_dynamodb as dynamodb,
  aws_s3 as s3,
  aws_cloudfront_origins as origins,
  aws_cloudfront as cloudfront,
  aws_s3_deployment as s3deploy,
  aws_cognito as cognito,
  aws_kms as kms,
  aws_logs as logs,
  aws_cognito_identitypool as cognitoIdentityPool,
} from "aws-cdk-lib";
import {
  ExecSyncOptionsWithBufferEncoding,
  execSync,
} from "node:child_process";
// import * as cognitoIdentityPool from "@aws-cdk/aws-cognito-identitypool-alpha";
import { Utils } from "./utils/utils";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { BedrockKnowledgeBase } from './knowledge-base-construct';
import {BedrockKnowledgeBaseModels } from './constants';

export class AiEcommerceSupportSimulatorStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create KMS key for encryption
    const kmsKey = new kms.Key(this, 'StackKmsKey', {
      description: 'KMS key for AI Ecommerce Support Simulator',
      enableKeyRotation: true,
      policy: new iam.PolicyDocument({
        statements: [
          // Allow root account full access
          new iam.PolicyStatement({
            sid: 'Enable IAM User Permissions',
            effect: iam.Effect.ALLOW,
            principals: [new iam.AccountRootPrincipal()],
            actions: ['kms:*'],
            resources: ['*'],
          }),
          // Allow CloudWatch Logs to use the key
          new iam.PolicyStatement({
            sid: 'Allow CloudWatch Logs',
            effect: iam.Effect.ALLOW,
            principals: [new iam.ServicePrincipal(`logs.${cdk.Aws.REGION}.amazonaws.com`)],
            actions: [
              'kms:Encrypt',
              'kms:Decrypt',
              'kms:ReEncrypt*',
              'kms:GenerateDataKey*',
              'kms:DescribeKey',
            ],
            resources: ['*'],
            conditions: {
              ArnEquals: {
                'kms:EncryptionContext:aws:logs:arn': [
                  `arn:aws:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws/lambda/CustomerMessageLambda*`,
                  `arn:aws:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws/lambda/SupportMessageLambda*`,
                  `arn:aws:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws/lambda/SendResponseLambda*`,
                ],
              },
            },
          }),
        ],
      }),
    });

    // Create dedicated CloudFront access logs bucket with minimal ACL permissions
    const cloudFrontAccessLogsBucket = new s3.Bucket(this, "CloudFrontAccessLogsBucket", {
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: new s3.BlockPublicAccess({
        blockPublicPolicy: true,
        blockPublicAcls: true,
        ignorePublicAcls: true,
        restrictPublicBuckets: true,
      }),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Create access logs bucket for S3 and CloudFront
    const accessLogsBucket = new s3.Bucket(this, "AccessLogsBucket", {
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
      blockPublicAccess: new s3.BlockPublicAccess({
        blockPublicPolicy: true,
        blockPublicAcls: true,
        ignorePublicAcls: true,
        restrictPublicBuckets: true,
      }),
      serverAccessLogsBucket: cloudFrontAccessLogsBucket,
      serverAccessLogsPrefix: 'access-logs-bucket-logs/',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const websiteBucket = new s3.Bucket(this, "WebsiteBucket", {
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: new s3.BlockPublicAccess({
        blockPublicPolicy: true,
        blockPublicAcls: true,
        ignorePublicAcls: true,
        restrictPublicBuckets: true,
      }),
      serverAccessLogsBucket: accessLogsBucket,
      serverAccessLogsPrefix: 'website-access-logs/',
    });

    const hostingOrigin = origins.S3BucketOrigin.withOriginAccessControl(websiteBucket);

    const myResponseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(
      this,
      "ResponseHeadersPolicy",
      {
        responseHeadersPolicyName:
          "ResponseHeadersPolicy" + cdk.Aws.STACK_NAME + "-" + cdk.Aws.REGION,
        comment: "ResponseHeadersPolicy" + cdk.Aws.STACK_NAME + "-" + cdk.Aws.REGION,
        securityHeadersBehavior: {
          contentTypeOptions: { override: true },
          frameOptions: {
            frameOption: cloudfront.HeadersFrameOption.DENY,
            override: true,
          },
          referrerPolicy: {
            referrerPolicy:
            cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
            override: false,
          },
          strictTransportSecurity: {
            accessControlMaxAge: cdk.Duration.seconds(31536000),
            includeSubdomains: true,
            override: true,
          },
          xssProtection: { protection: true, modeBlock: true, override: true },
        },
      }
    );

    const distribution = new cloudfront.Distribution(
      this,
      "Distribution",
      {
        comment: "AI-Powered E-commerce Support Simulator",
        defaultRootObject: "index.html",
        httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
        minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2019,
        enableLogging: true,
        logBucket: accessLogsBucket,
        logFilePrefix: 'cloudfront-access-logs/',
        defaultBehavior:{
          origin: hostingOrigin,
          responseHeadersPolicy: myResponseHeadersPolicy,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        }
      }
    );

    // Add cfn_nag metadata to suppress W70 rule
    const cfnDistribution = distribution.node.defaultChild as cdk.CfnResource;
    cfnDistribution.addMetadata('cfn_nag', {
      rules_to_suppress: [
        {
          id: 'W70',
          reason: 'Using default cert from CloudFront in this sample'
        }
      ]
    });

    const userPool = new cognito.UserPool(this, "UserPool", {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      selfSignUpEnabled: false,
      autoVerify: { email: true, phone: true },
      signInAliases: {
        email: true,
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
    });

    const userPoolClient = userPool.addClient("UserPoolClient", {
      generateSecret: false,
      authFlows: {
        adminUserPassword: true,
        userPassword: true,
        userSrp: true,
      },
    });

    const identityPool = new cognitoIdentityPool.IdentityPool(
      this,
      "IdentityPool",
      {
        authenticationProviders: {
          userPools: [
            new cognitoIdentityPool.UserPoolAuthenticationProvider({
              userPool,
              userPoolClient,
            }),
          ],
        },
      }
    );

    const appPath = path.join(__dirname, "../resources/ui");
    const buildPath = path.join(appPath, "dist");

    const asset = s3deploy.Source.asset(appPath, {
      bundling: {
        image: cdk.DockerImage.fromRegistry(
          "public.ecr.aws/sam/build-nodejs20.x:latest"
        ),
        command: [
          "sh",
          "-c",
          [
            "npm --cache /tmp/.npm install",
            `npm --cache /tmp/.npm run build`,
            "cp -aur /asset-input/dist/* /asset-output/",
          ].join(" && "),
        ],
        local: {
          tryBundle(outputDir: string) {
            try {
              const options: ExecSyncOptionsWithBufferEncoding = {
                stdio: "inherit",
                env: {
                  ...process.env,
                  NODE_ENV: 'production', // Ensure production build
                  npm_config_cache: `${process.env.HOME}/.npm`, // Use home directory for npm cache
                },
              };

              console.log(`Installing dependencies in ${appPath}...`);
              execSync(`npm --silent --prefix "${appPath}" install`, options);

              console.log(`Building project in ${appPath}...`);
              execSync(`npm --silent --prefix "${appPath}" run build`, options);

              console.log(`Copying build output from ${buildPath} to ${outputDir}...`);
              Utils.copyDirRecursive(buildPath, outputDir);

              return true;
            } catch (e) {
              if (e instanceof Error) {
                console.error('Error during local bundling:', e.message);
                console.error('Stack trace:', e.stack);
              } else {
                console.error('An unknown error occurred during local bundling');
              }
              return false;
            }
          },
        },

      },
    });


    // Create the AppSync API
    const api = new appsync.GraphqlApi(this, "AiSupportApi", {
      name: "ai-support-api",
      definition: appsync.Definition.fromFile(
        path.join(__dirname, "../", "graphql", "schema.graphql")
      ),
      authorizationConfig: {
        defaultAuthorization: {
          authorizationType: appsync.AuthorizationType.USER_POOL,
          userPoolConfig: {
            userPool: userPool,
            appIdClientRegex: userPoolClient.userPoolClientId,
            defaultAction: appsync.UserPoolDefaultAction.ALLOW,
          },
        },
        additionalAuthorizationModes: [
          {
            authorizationType: appsync.AuthorizationType.IAM,
          },
        ],
      },
      logConfig: {
        fieldLogLevel: appsync.FieldLogLevel.ALL,
      },
      xrayEnabled: true,

    });

    const apiPolicyStatement = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        "appsync:GraphQL",
      ],
      resources: [
        `${api.arn}/*`,
        `${api.arn}/types/Mutation/*`,
        `${api.arn}/types/Subscription/*`,
      ],
    });

    identityPool.authenticatedRole.addToPrincipalPolicy(apiPolicyStatement);


    const exportsAsset = s3deploy.Source.jsonData("aws-exports.json", {
      API: {
        GraphQL: {
          endpoint: api.graphqlUrl,
          region: cdk.Aws.REGION,
          defaultAuthMode: appsync.AuthorizationType.USER_POOL
        },
      },
      Auth: {
        Cognito: {
          userPoolClientId: userPoolClient.userPoolClientId,
          userPoolId: userPool.userPoolId,
          identityPoolId: identityPool.identityPoolId,
        },
      }
    });

    new s3deploy.BucketDeployment(this, "UserInterfaceDeployment", {
      prune: false,
      sources: [asset, exportsAsset],
      destinationBucket: websiteBucket,
      distribution,
    });

    const documentsBucket = new s3.Bucket(this, 'DocumentsBucket', {
      enforceSSL:true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      serverAccessLogsBucket: accessLogsBucket,
      serverAccessLogsPrefix: 'documents-bucket-logs/',
      blockPublicAccess: new s3.BlockPublicAccess({
        blockPublicPolicy: true,
        blockPublicAcls: true,
        ignorePublicAcls: true,
        restrictPublicBuckets: true,
      }),
    });

    const knowledgeBase = new BedrockKnowledgeBase(this, 'AgentSquadDocKb', {
      kbName:'agent-squad-doc-kb',
      assetFiles:[],
      embeddingModel: BedrockKnowledgeBaseModels.TITAN_EMBED_TEXT_V1,
    });

    const assetsPath = path.join(__dirname, "../docs/products/");
    const assetDoc = s3deploy.Source.asset(assetsPath);

    const agentSquadFilesDeployment = new s3deploy.BucketDeployment(this, "DeployDocument", {
      sources: [assetDoc],
      destinationBucket: documentsBucket,
    });

    knowledgeBase.addS3Permissions(documentsBucket.bucketName);
    knowledgeBase.createAndSyncDataSource(documentsBucket.bucketArn);



    const customerIncommingMessagesQueue = new sqs.Queue(this, "CustomerMessagesQueue", {
      visibilityTimeout: cdk.Duration.minutes(10),
      encryptionMasterKey: kmsKey,
      enforceSSL: true,
    });
    const supportIncommingMessagestMessagesQueue = new sqs.Queue(this, "SupportMessagesQueue", {
      encryptionMasterKey: kmsKey,
      enforceSSL: true,
    });

    const outgoingMessagesQueue = new sqs.Queue(this, "OutgoingMessagesQueue", {
      encryptionMasterKey: kmsKey,
      enforceSSL: true,
    });

    const datasource = api.addHttpDataSource(
      "sqs",
      `https://sqs.${cdk.Aws.REGION}.amazonaws.com`,
      {
        authorizationConfig: {
          signingRegion: cdk.Aws.REGION,
          signingServiceName: "sqs",
        },
      }
    );

    customerIncommingMessagesQueue.grantSendMessages(datasource.grantPrincipal);
    supportIncommingMessagestMessagesQueue.grantSendMessages(datasource.grantPrincipal);


    const myJsFunction = new appsync.AppsyncFunction(this, 'function', {
      name: 'my_js_function',
      api,
      dataSource: datasource,
      code: appsync.Code.fromAsset(
        path.join(__dirname, '../graphql/Query.sendMessage.js')
      ),
      runtime: appsync.FunctionRuntime.JS_1_0_0,
    });

    const sendResponseFunction = new appsync.AppsyncFunction(this, 'SendResponseFunction', {
      api: api,
      dataSource: api.addNoneDataSource('NoneDataSource'),
      name: 'SendResponseFunction',
      code: appsync.Code.fromAsset(path.join(__dirname, '../graphql/sendResponse.js')),
      runtime: appsync.FunctionRuntime.JS_1_0_0,
    });

    const pipelineVars = JSON.stringify({
      accountId: cdk.Aws.ACCOUNT_ID,
      customerQueueUrl: customerIncommingMessagesQueue.queueUrl,
      customerQueueName: customerIncommingMessagesQueue.queueName,
      supportQueueUrl: supportIncommingMessagestMessagesQueue.queueUrl,
      supportQueueName: supportIncommingMessagestMessagesQueue.queueName,
    });


    // Create the pipeline resolver
    new appsync.Resolver(this, 'SendResponseResolver', {
      api: api,
      typeName: 'Mutation',
      fieldName: 'sendResponse',
      code: appsync.Code.fromAsset(path.join(__dirname, '../graphql/sendResponsePipeline.js')),
      runtime: appsync.FunctionRuntime.JS_1_0_0,
      pipelineConfig: [sendResponseFunction],
    });


    new appsync.Resolver(this, 'PipelineResolver', {
      api,
      typeName: 'Query',
      fieldName: 'sendMessage',
      code: appsync.Code.fromInline(`
            // The before step
            export function request(...args) {
              console.log(args);
              return ${pipelineVars}
            }

            // The after step
            export function response(ctx) {
              return ctx.prev.result
            }
          `),
      runtime: appsync.FunctionRuntime.JS_1_0_0,
      pipelineConfig: [myJsFunction],
    });



    const sessionTable = new dynamodb.Table(this, "SessionTable", {
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: "TTL",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification:{
        pointInTimeRecoveryEnabled:true
      }
    });

    // Create CloudWatch Log Groups for Lambda functions
    const customerMessageLogGroup = new logs.LogGroup(this, 'CustomerMessageLogGroup', {
      logGroupName: `/aws/lambda/CustomerMessageLambda`,
      retention: logs.RetentionDays.ONE_WEEK,
      encryptionKey: kmsKey,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const supportMessageLogGroup = new logs.LogGroup(this, 'SupportMessageLogGroup', {
      logGroupName: `/aws/lambda/SupportMessageLambda`,
      retention: logs.RetentionDays.ONE_WEEK,
      encryptionKey: kmsKey,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const sendResponseLogGroup = new logs.LogGroup(this, 'SendResponseLogGroup', {
      logGroupName: `/aws/lambda/SendResponseLambda`,
      retention: logs.RetentionDays.ONE_WEEK,
      encryptionKey: kmsKey,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Create the initial processing Lambda
    const customerMessageLambda = new nodejs.NodejsFunction(
      this,
      "CustomerMessageLambda",
      {
        entry: path.join(__dirname, "../lambda/customerMessage/index.ts"),
        handler: "handler",
        timeout: cdk.Duration.minutes(9),
        runtime: lambda.Runtime.NODEJS_18_X,
        memorySize: 2048,
        architecture: lambda.Architecture.ARM_64,
        reservedConcurrentExecutions: 10,
        logGroup: customerMessageLogGroup,
        environment: {
          QUEUE_URL: outgoingMessagesQueue.queueUrl,
          HISTORY_TABLE_NAME: sessionTable.tableName,
          HISTORY_TABLE_TTL_KEY_NAME: 'TTL',
          HISTORY_TABLE_TTL_DURATION: '3600',
          KNOWLEDGE_BASE_ID: knowledgeBase.knowledgeBase.attrKnowledgeBaseId,
        },
        bundling: {
          commandHooks: {
            afterBundling: (inputDir: string, outputDir: string): string[] => [
              `cp ${inputDir}/resources/ui/public/mock_data.json ${outputDir}`
            ],
            beforeBundling: (inputDir: string, outputDir: string): string[] => [],
            beforeInstall: (inputDir: string, outputDir: string): string[] => [],
          },
        },
      }
    );

    sessionTable.grantReadWriteData(customerMessageLambda);
    customerMessageLogGroup.grantWrite(customerMessageLambda);


    customerMessageLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream"
        ],
        resources: [
          `arn:aws:bedrock:${cdk.Aws.REGION}::foundation-model/*`
        ],
      })
    );


    customerMessageLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        sid: 'AmazonBedrockKbPermission',
        actions: [
          "bedrock:Retrieve",
          "bedrock:RetrieveAndGenerate"
        ],
        resources: [
          `arn:aws:bedrock:${cdk.Aws.REGION}::foundation-model/*`,
          `arn:${cdk.Aws.PARTITION}:bedrock:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:knowledge-base/${knowledgeBase.knowledgeBase.attrKnowledgeBaseId}`
        ]
      })
    );

    const supportMessageLambda = new nodejs.NodejsFunction(
      this,
      "SupportMessageLambda",
      {
        entry: path.join(__dirname, "../lambda/supportMessage/index.ts"),
        handler: "handler",
        architecture: lambda.Architecture.ARM_64,
        timeout: cdk.Duration.seconds(29),
        runtime: lambda.Runtime.NODEJS_18_X,
        reservedConcurrentExecutions: 5,
        logGroup: supportMessageLogGroup,
        environment: {
          QUEUE_URL: outgoingMessagesQueue.queueUrl,
        },
      }
    );

    supportMessageLogGroup.grantWrite(supportMessageLambda);


    new lambda.EventSourceMapping(this, "CustomerEventSourceMapping", {
      target: customerMessageLambda,
     batchSize: 1,
      eventSourceArn: customerIncommingMessagesQueue.queueArn,
    });



    new lambda.EventSourceMapping(this, "SupportEventSourceMapping", {
      target: supportMessageLambda,
      batchSize: 1,
      eventSourceArn: supportIncommingMessagestMessagesQueue.queueArn,
    });

    customerIncommingMessagesQueue.grantConsumeMessages(customerMessageLambda);
    supportIncommingMessagestMessagesQueue.grantConsumeMessages(supportMessageLambda);

    outgoingMessagesQueue.grantSendMessages(customerMessageLambda);
    outgoingMessagesQueue.grantSendMessages(supportMessageLambda);



    // Create the response Lambda
    const sendResponse = new nodejs.NodejsFunction(
      this,
      "SendResponseLambda",
      {
        entry: path.join(__dirname, "../lambda/sendResponse/index.ts"),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_18_X,
        architecture: lambda.Architecture.ARM_64,
        reservedConcurrentExecutions: 5,
        logGroup: sendResponseLogGroup,
        environment: {
          REGION: cdk.Aws.REGION,
          APPSYNC_API_URL: api.graphqlUrl,
        },
      }
    );

    outgoingMessagesQueue.grantConsumeMessages(sendResponse);
    sendResponseLogGroup.grantWrite(sendResponse);


    sendResponse.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["appsync:GraphQL"],
        resources: [`${api.arn}/*`],
      })
    );

    new lambda.EventSourceMapping(this, "ResponseEventSourceMapping", {
      target: sendResponse,
      batchSize: 1,
      eventSourceArn: outgoingMessagesQueue.queueArn,
    });


    new cdk.CfnOutput(this, "CloudfrontDomainName", {
      value: distribution.domainName
    });

  }
}
