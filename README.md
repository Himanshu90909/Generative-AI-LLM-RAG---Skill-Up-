# Generative-AI-LLM-RAG---Skill-Up-
## Introduction to TensorFlow

TensorFlow is an open-source framework for machine learning and artificial intelligence developed by Google Brain. It provides tools to build, train and deploy models across different platforms, especially for deep learning tasks.

Supports a wide range of applications such as NLP, computer vision, time series forecasting and reinforcement learning
Enables scalable model development and deployment across devices
<img width="391" height="400" alt="image" src="https://github.com/user-attachments/assets/178ed1ad-e604-4346-bfc8-0961c269fdc8" />



## 1. Scalability
TensorFlow is designed to scale across a variety of platforms from desktops and servers to mobile devices and embedded systems. It supports distributed computing allowing models to be trained on large datasets efficiently.

## 2. Comprehensive Ecosystem
TensorFlow offers a broad set of tools and libraries including:

TensorFlow Core: The base API for TensorFlow that allows users to define models, build computations and execute them.
Keras: Keras is integrated into TensorFlow (tf.keras) and is its official high-level API.
TensorFlow Lite: A lightweight solution for deploying models on mobile and embedded devices.
TensorFlow.js: A library for running machine learning models directly in the browser using JavaScript.
TensorFlow Extended (TFX): A production-ready solution for deploying machine learning models in production environments.
TensorFlow Hub: A repository of pre-trained models that can be easily integrated into applications.

## 3. Automatic Differentiation (Autograd)
TensorFlow automatically calculates gradients for all trainable variables in the model which simplifies the backpropagation process during training. This is a core feature that enables efficient model optimization using techniques like gradient descent.

##4. Multi-language Support
TensorFlow is primarily designed for Python but it also provides APIs for other languages like C++, Java and JavaScript making it accessible to developers with different programming backgrounds.

##5. TensorFlow Serving and TensorFlow Model Optimization
TensorFlow includes tools for serving machine learning models in production environments and optimizing them for inference allowing for lower latency and higher efficiency.

TensorFlow Architecture
The architecture of TensorFlow revolves around the concept of a computational graph which is a network of nodes (operations) and edges (data). Here's a breakdown of key components:

Tensors: Tensors are the fundamental units of data in TensorFlow. They are multi-dimensional arrays or matrices used for storing data. A tensor can have one dimension (vector), two dimensions (matrix) or more dimensions.

<img width="959" height="362" alt="image" src="https://github.com/user-attachments/assets/80da6e20-5b37-4858-ab34-62f6c574e892" />

Graph: A TensorFlow graph represents a computation as a flow of tensors through a series of operations. Each operation in the graph performs a specific mathematical function on the input tensors such as matrix multiplication, addition or activation.
In TensorFlow 2.x, computations are executed eagerly by default, meaning operations run immediately without requiring a separate session.
