#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from '@aws-cdk/core';
import { BenkhardJenkinsStack } from '../lib/benkhard-jenkins-stack';

const app = new cdk.App();
new BenkhardJenkinsStack(app, 'BenkhardJenkinsStack');
